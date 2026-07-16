/**
 * LiveConnection (§11): wires a {@link LiveStore} to the server transport —
 * SSE downstream (`EventSource` auto-reconnect), HTTP POST upstream.
 * Connections are disposable; state is not.
 *
 * WIRE CONTRACT — the envelope/batch/control shapes and the connect + reconnect
 * behavior here are documented in
 * docs-site/src/content/docs/concepts/wire-protocol.md and pinned by
 * packages/core/test/protocol-conformance.test.ts. Change all three together.
 */
import {
  type ConnectionStatus,
  canonicalProps,
  type Envelope,
  type MountBatchResult,
  type RpcBatch,
  redirect,
} from "@rpxd/core";
import { LiveStore, type RpcMeta } from "./store.ts";

/** The slice of `EventSource` the connection uses — injectable for tests. */
export interface EventSourceLike {
  addEventListener(type: string, listener: (event: { data: string }) => void): void;
  close(): void;
  /** 0 CONNECTING, 1 OPEN, 2 CLOSED — CLOSED on `error` means a refused connection (§11). */
  readonly readyState?: number;
}

/** The slice of `WebSocket` the connection uses — injectable for tests (§11 ws opt-in). */
export interface WebSocketLike {
  addEventListener(
    type: string,
    listener: (event: { data?: unknown; code?: number }) => void,
  ): void;
  send(data: string): void;
  close(): void;
}

const WS_BACKOFF_BASE_MS = 1000;
const WS_BACKOFF_CAP_MS = 30_000;
/** `EventSource.readyState` CLOSED — an `error` in this state is a refused stream. */
const ES_CLOSED = 2;
/** WS policy-violation close code the server uses for an auth/origin rejection (§11, W7). */
const WS_POLICY_CLOSE = 4403;

/** A per-connection stream id — `crypto.randomUUID` where available, else a fallback. */
function randomId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  return c?.randomUUID
    ? c.randomUUID()
    : `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

/**
 * Normalize a server-supplied redirect to a same-origin target, or `null` if it
 * isn't one. Accepts a plain relative path; accepts a same-origin absolute URL
 * (returning its path+query+hash); rejects protocol-relative `//host`,
 * cross-origin URLs, and non-http schemes like `javascript:`.
 */
function safeRedirectTarget(target: string): string | null {
  if (target.startsWith("/") && !target.startsWith("//")) return target;
  try {
    const origin = typeof location !== "undefined" ? location.origin : undefined;
    if (origin) {
      const u = new URL(target, origin);
      if (u.origin === origin) return `${u.pathname}${u.search}${u.hash}`;
    }
  } catch {
    // malformed URL — fall through to reject
  }
  return null;
}

/** SSR bootstrap payload embedded by the server (§12). */
export interface Bootstrap {
  instance: string;
  seq: number;
  attachToken: string;
  snapshot: { state: unknown; session: unknown };
}

/**
 * A mounted slot's control surface (ADR 0002 item 9): its own {@link LiveStore}
 * plus the operations `<LiveSlot>` (item 10) drives it with. A slot rides the
 * page's app-lifetime connection — its envelopes multiplex over the same stream
 * — but keeps a store of its own, so its optimistic queue, `keyOf`, and errors
 * are isolated from the page and from sibling slots.
 *
 * @example
 * ```ts
 * const chat = await conn.mountSlot(fillPattern("/chat/$id", { id: "main" }), { tools }, { meta });
 * chat.onDeny((loc) => setDenied(loc)); // render a fallback instead of soft-navigating
 * chat.store.rpc.send({ text: "hi" });
 * chat.patchProps({ tools: nextTools }); // re-guard + re-load on the same instance
 * chat.release(); // on unmount
 * ```
 */
export interface SlotHandle<S = unknown, Session = Record<string, unknown>> {
  /** The slot's isolated store — subscribe/render it like the page store. */
  readonly store: LiveStore<S, Session>;
  /** The server instance id this slot is bound to. */
  readonly instance: string;
  /**
   * The pattern-filled identity path this slot mounted (ADR 0002 item 12). The
   * release/mount pair-cancellation matches a pending release to a pending mount
   * by this exact string, so a React remount across a page swap is a no-op.
   */
  readonly path: string;
  /** Tier-1 props change for this slot: a `url` message → re-guard + re-load. */
  patchProps(props: Record<string, unknown>): void;
  /**
   * Abandon the slot. Deferred like a mount (ADR 0002 item 12): the release
   * joins the next microtask flush, so a same-tick release+mount for this same
   * identity — a React remount across a keyed page swap — cancels before either
   * touches the wire (the instance/store survive and the remounting caller
   * rebinds to them). A release with no cancelling mount flushes for real.
   */
  release(): void;
  /**
   * Register a runtime-deny sink for this slot (§10). A `guard`/`load` deny —
   * at mount or on a later `patchProps` — fires this instead of the app-level
   * redirect, so a denied slot renders `fallback` while the page stays live.
   */
  onDeny(fn: (location: string) => void): void;
}

/** Constructor options for {@link LiveConnection}. */
export interface ConnectionOptions {
  /** Instance id (from SSR bootstrap or a control mount response). */
  instance: string;
  meta?: Record<string, RpcMeta>;
  /** Origin prefix, default same-origin (""). */
  base?: string;
  /** SSR bootstrap: seeds the store and attaches to the warm instance (§12). */
  bootstrap?: Bootstrap;
  /**
   * Transport (§11): `"sse"` (default) or `"ws"` — one duplex socket, same
   * envelope protocol, identical API shape.
   */
  transport?: "sse" | "ws";
  /**
   * Runtime redirect sink (§10): a `guard`/`load` deny during a URL change
   * (`nav.patch`) or a tier-2 remount. The app soft-navigates to the target.
   */
  onRedirect?: (location: string) => void;
  /** Injectable transport primitives (tests, non-browser environments). */
  fetchImpl?: typeof fetch;
  eventSource?: (url: string) => EventSourceLike;
  webSocket?: (url: string) => WebSocketLike;
}

/**
 * One `mountSlot` call awaiting the next microtask flush (ADR 0002 item 11).
 * The flush sends a single `mount` for one queued entry or a `mount-batch` for
 * many, then settles each entry's promise with its own positional result — so a
 * sibling's deny/error never affects this one. Generics are erased in the queue
 * (a heterogeneous batch can't share one type param); `mountSlot` casts back.
 */
interface PendingSlotMount {
  path: string;
  props: Record<string, unknown>;
  meta?: Record<string, RpcMeta>;
  resolve: (handle: SlotHandle) => void;
  reject: (err: unknown) => void;
}

/**
 * One `release()` awaiting the same microtask flush as pending mounts (ADR 0002
 * item 12). At flush time a release whose `path` matches a pending mount's path
 * cancels the pair — neither hits the wire, and the mount rebinds to the still-
 * registered store; a release with no partner flushes a real `release` control.
 */
interface PendingRelease {
  path: string;
  instance: string;
}

/**
 * Client connection for one live object instance.
 *
 * @example
 * ```ts
 * const boot = JSON.parse(document.getElementById("__rpxd")!.textContent!);
 * const conn = new LiveConnection({ instance: boot.instance, bootstrap: boot, meta });
 * conn.connect();
 * conn.store.rpc.create({ name: "x" });
 * ```
 */
export class LiveConnection<S = unknown, Session = Record<string, unknown>> {
  readonly #opts: ConnectionOptions;
  /** The PRIMARY (page) instance — swapped by a tier-2/3 remount (§7, ADR item 9). */
  #instance: string;
  /**
   * instance id → store (ADR item 9). One app-lifetime connection multiplexes
   * every instance of the session — the page plus any mounted slots — over the
   * same stream; each keeps its own store (isolated optimistic queue/keyOf).
   * The primary is always registered under {@link store}.
   */
  readonly #stores = new Map<string, LiveStore>();
  /**
   * instance id → runtime-deny sink (§10, ADR item 9). Consulted before the
   * primary redirect check so a slot's deny fires its `onDeny`, never the app.
   */
  readonly #denySinks = new Map<string, (location: string) => void>();
  /** Client-owned stream id: names this connection's stream for late-mount/release (§7). */
  readonly #streamId = randomId();
  /** Monotonic remount tag — a superseded tier-2 remount must not rebind the store (§7). */
  #remountRunId = 0;
  /**
   * Correlation id of the in-flight socket `mount` frame (#65). A mount that
   * denies before binding answers with `instance: ""`, which the bound-instance
   * filter can never match — the server echoes this id instead. Single slot:
   * latest-wins (§7) already says only the newest mount owns the outcome.
   */
  #pendingMountId: string | null = null;
  /**
   * `mountSlot` calls queued for the next microtask flush (ADR 0002 item 11).
   * Same-tick sibling slots coalesce here so a page rendering N `<LiveSlot>`s
   * sends ONE `mount-batch` POST, not N `mount`s. Drained by {@link #flushSlotMounts}.
   */
  #pendingSlotMounts: PendingSlotMount[] = [];
  /**
   * `release()` calls queued for the next microtask flush (ADR 0002 item 12).
   * Flushed alongside {@link #pendingSlotMounts}: a release paired with a
   * same-path mount cancels (neither hits the wire); an unpaired one sends a
   * real `release`. Deferring the release is what makes the cancellation
   * possible — an immediate fire-and-forget release would always beat the mount.
   */
  #pendingReleases: PendingRelease[] = [];
  /**
   * instance id → canonical serialization ({@link canonicalProps}) of the props
   * the server was last told for that slot (mount props, then each `patchProps`).
   * The pair-cancellation dedup baseline (ADR 0002 item 12): a rebind forwards a
   * `url` patch only when the remounting caller's props differ from this.
   */
  readonly #slotProps = new Map<string, string>();
  /** Whether a microtask flush of the pending mount/release queues is scheduled. */
  #slotFlushScheduled = false;
  /** Runtime-redirect sink (§10) — seeded from opts, settable for SSR connections. */
  #onRedirect: ((location: string) => void) | undefined;
  #source: EventSourceLike | undefined;
  #socket: WebSocketLike | undefined;
  #socketOpen = false;
  #closed = false;
  #everOpened = false;
  #retryAttempt = 0;

  constructor(opts: ConnectionOptions) {
    this.#opts = opts;
    this.#instance = opts.instance;
    this.#onRedirect = opts.onRedirect;
    const primary = this.#makeStore(opts.instance);
    this.#stores.set(opts.instance, primary as LiveStore);
    if (opts.bootstrap) {
      // Seed confirmed state from the SSR snapshot — no connect spinner (§12).
      primary.applyEnvelope({
        seq: opts.bootstrap.seq,
        instance: opts.instance,
        full: opts.bootstrap.snapshot as { state: unknown; session: unknown },
      });
    }
  }

  /** The store for the PRIMARY (page) instance. A tier-2/3 remount swaps it (§7). */
  get store(): LiveStore<S, Session> {
    return this.#stores.get(this.#instance) as unknown as LiveStore<S, Session>;
  }

  /** Install/replace the runtime-redirect sink (§10) — the app shell wires it to soft-nav. */
  setRedirectSink(fn: (location: string) => void): void {
    this.#onRedirect = fn;
  }

  /**
   * Build a store bound to `instance` with its own rpc `meta` (ADR item 9: meta
   * moves per-store — the page's on construction/remount, a slot's at
   * `mountSlot`). Its resync/rpc/send target that exact id over the shared stream.
   */
  #makeStore<T = S, TSession = Session>(
    instance: string,
    meta?: Record<string, RpcMeta>,
  ): LiveStore<T, TSession> {
    return new LiveStore<T, TSession>({
      instance,
      meta: meta ?? this.#opts.meta,
      send: (batch) => this.#send(batch),
      requestResync: () => void this.#control({ type: "resync", instance }),
    });
  }

  /** Dispatch a downstream envelope to its instance's store, if one is registered. */
  #dispatchEnvelope(env: Envelope): void {
    if (this.#handleRedirectEnvelope(env)) return;
    const store = this.#stores.get(env.instance);
    if (!store) return; // an instance we don't (or no longer) hold — ignore
    store.applyEnvelope(env);
    if (store.status !== "live") store.setStatus("live");
  }

  /** Fan a transport status change to every registered store (shared transport). */
  #setStatusAll(status: ConnectionStatus): void {
    for (const store of this.#stores.values()) store.setStatus(status);
  }

  /** Resend every store's unacked batches after reconnect — the server dedupes (§11). */
  #resendAllUnacked(): void {
    for (const store of this.#stores.values()) store.resendUnacked();
  }

  /** Open the transport. SSE reconnects via EventSource; WS retries with backoff. */
  connect(): void {
    if (this.#opts.transport === "ws") {
      this.#connectWs();
      return;
    }
    if (this.#source) return;
    const base = this.#opts.base ?? "";
    const boot = this.#opts.bootstrap;
    const query = new URLSearchParams();
    if (boot) {
      query.set("attach", boot.attachToken);
      query.set("seq", String(boot.seq));
    }
    // Name this stream so a tier-2 remount can join/release instances on it (§7).
    query.set("stream", this.#streamId);
    const factory =
      this.#opts.eventSource ??
      ((url: string) => new EventSource(url) as unknown as EventSourceLike);
    const source = factory(`${base}/__rpxd/stream?${query}`);
    this.#source = source;
    this.#setStatusAll("connecting");

    source.addEventListener("open", () => {
      const reconnected = this.#everOpened;
      this.#everOpened = true;
      // Reconnect fans to EVERY store (ADR item 9): unacked optimistic rpcs are
      // resent with their original ids (server dedupes, §11), and every store —
      // page and slots — recovers via the server's full-snapshot-on-resubscribe
      // (subscribeSession resyncs every session instance when the stream
      // re-subscribes). No per-store resync request is needed on the client.
      this.#setStatusAll("live");
      if (reconnected) this.#resendAllUnacked();
    });
    source.addEventListener("env", (event) => {
      this.#dispatchEnvelope(JSON.parse(event.data) as Envelope);
    });
    source.addEventListener("error", () => {
      // A refusal before we ever opened (auth/origin 403) closes the
      // EventSource for good — readyState CLOSED with no prior `open`. That's
      // terminal: close it so it can't native-reconnect into a 403 loop and
      // settle on `error` (§11, W7). A drop *after* a successful open is
      // transient — leave the EventSource to auto-reconnect (`reconnecting`).
      if (!this.#everOpened && source.readyState === ES_CLOSED) {
        source.close();
        this.#source = undefined;
        this.#setStatusAll("error");
        return;
      }
      this.#setStatusAll("reconnecting");
    });
  }

  #connectWs(): void {
    if (this.#socket || this.#closed) return;
    const boot = this.#opts.bootstrap;
    // Attach params are only valid for the first connect; reconnects resync.
    const attach = boot && !this.#everOpened ? `?attach=${boot.attachToken}&seq=${boot.seq}` : "";
    const base = this.#opts.base ?? "";
    const wsBase = base
      ? base.replace(/^http/, "ws")
      : typeof window !== "undefined"
        ? window.location.origin.replace(/^http/, "ws")
        : "";
    const factory =
      this.#opts.webSocket ?? ((url: string) => new WebSocket(url) as unknown as WebSocketLike);
    const socket = factory(`${wsBase}/__rpxd/ws${attach}`);
    this.#socket = socket;
    this.#setStatusAll(this.#everOpened ? "reconnecting" : "connecting");

    socket.addEventListener("open", () => {
      const reconnected = this.#everOpened;
      this.#everOpened = true;
      this.#socketOpen = true;
      this.#retryAttempt = 0;
      // Fan to every store (ADR item 9); the server resyncs every session
      // instance when the new socket re-subscribes (subscribeSession).
      this.#setStatusAll("live");
      if (reconnected) this.#resendAllUnacked();
    });
    socket.addEventListener("message", (event) => {
      this.#dispatchEnvelope(JSON.parse(String(event.data)) as Envelope);
    });
    const retry = () => {
      if (this.#socket !== socket) return;
      this.#socket = undefined;
      this.#socketOpen = false;
      if (this.#closed) return;
      this.#setStatusAll("reconnecting");
      // Exponential backoff with jitter (§11): the delay lands in
      // [window/2, window], window doubling per attempt up to the cap —
      // spreads a fleet of clients after a server bounce.
      const window = Math.min(WS_BACKOFF_CAP_MS, WS_BACKOFF_BASE_MS * 2 ** this.#retryAttempt);
      this.#retryAttempt += 1;
      const delay = window / 2 + Math.random() * (window / 2);
      setTimeout(() => this.#connectWs(), delay);
    };
    socket.addEventListener("close", (event) => {
      // A browser WS client can't tell a refused upgrade (auth/origin 403)
      // from a transient failure — both close pre-`open` with a generic code,
      // and the HTTP status of a failed upgrade is never exposed. So a close
      // without an explicit signal always backoff-reconnects (a server bounce
      // on first load must not strand the page). The one terminal signal is
      // the `4403` policy close code: a server that closes an *established*
      // socket with it is saying "don't come back" (§11, W7).
      if (event.code === WS_POLICY_CLOSE) {
        if (this.#socket !== socket) return;
        this.#socket = undefined;
        this.#socketOpen = false;
        this.#setStatusAll("error");
        return;
      }
      retry();
    });
    socket.addEventListener("error", () => {
      this.#setStatusAll("reconnecting");
    });
  }

  /**
   * Tier-1 props change (§7): rerun `guard`+`load` for a new URL over the same
   * instance — no `setup`, state preserved (keepPreviousData). A `guard` deny
   * comes back as `{ redirect }` (SSE control response) or a `redirect` envelope
   * (WS) and is routed to `onRedirect` for a soft-nav (§10).
   */
  patchProps(props: Record<string, string>): void {
    this.#sendUrl(this.#instance, props);
  }

  /**
   * Send a `url` (tier-1 props) message for one instance and route a deny back
   * to the right sink: a slot instance's `onDeny` (via {@link #denySinks}) or —
   * for the primary — the app-level redirect. WS denies arrive as `redirect`
   * envelopes (see the socket `message` handler); SSE denies come back as a
   * `{ redirect }` control response consumed here.
   */
  #sendUrl(instance: string, props: Record<string, unknown>): void {
    if (this.#opts.transport === "ws" && this.#socketOpen && this.#socket) {
      // A WS deny arrives as a `redirect` envelope on the socket (see message).
      this.#socket.send(JSON.stringify({ type: "url", instance, props }));
      return;
    }
    void this.#control({ type: "url", instance, props }).then((res) => {
      if (res instanceof Response && res.ok) void this.#consumeRedirect(res, instance);
    });
  }

  /**
   * Mount a slot over this app-lifetime connection (ADR 0002 items 9 + 11). Does
   * **not** hit the wire immediately: the call is enqueued and a microtask flush
   * is scheduled, so N sibling slots rendered in one tick coalesce into a single
   * control POST — a lone same-tick mount stays an unbatched `mount`, 2+ become
   * one `mount-batch` ({@link #flushSlotMounts}). On a `setup`/`guard` deny the
   * returned promise rejects with `redirect()` for `<LiveSlot>` to surface as
   * `fallback`; on a props/cap/not-found error it rejects with an `Error`. On
   * success it registers a store bound to the returned instance, joins that
   * instance to the live stream (a WS `mount` frame joins the socket; SSE resyncs
   * after the mount already joined by stream id), and resolves a {@link SlotHandle}.
   * The slot's envelopes multiplex over the page's stream but never touch the
   * page's store, and one entry's outcome is independent of its batch siblings.
   *
   * @example
   * ```ts
   * const chat = await conn.mountSlot("/chat/main", { tools }, { meta: rpcMetaFromDef(Chat.def) });
   * useLiveStore(chat.store); // render it; page store is untouched
   * ```
   */
  mountSlot<T = unknown, TSession = Record<string, unknown>>(
    path: string,
    props: Record<string, unknown>,
    opts: { meta?: Record<string, RpcMeta> } = {},
  ): Promise<SlotHandle<T, TSession>> {
    return new Promise<SlotHandle<T, TSession>>((resolve, reject) => {
      this.#pendingSlotMounts.push({
        path,
        props,
        meta: opts.meta,
        // The queue is heterogeneous (each entry has its own T/TSession), so it
        // erases the generics; the caller's promise re-applies them on resolve.
        resolve: resolve as (handle: SlotHandle) => void,
        reject,
      });
      this.#scheduleSlotFlush();
    });
  }

  /** Schedule the shared mount/release microtask flush once per tick (item 11/12). */
  #scheduleSlotFlush(): void {
    if (this.#slotFlushScheduled) return;
    this.#slotFlushScheduled = true;
    queueMicrotask(() => void this.#flushSlotMounts());
  }

  /**
   * Queue a slot release for the next flush (ADR 0002 item 12) instead of firing
   * a `release` control immediately. Deferral is what lets a same-tick
   * release+mount for one identity cancel: a React remount across a keyed page
   * swap enqueues a release (unmount cleanup) and a mount (the next page's effect)
   * in the same tick, and {@link #flushSlotMounts} cancels the pair.
   */
  #enqueueRelease(path: string, instance: string): void {
    this.#pendingReleases.push({ path, instance });
    this.#scheduleSlotFlush();
  }

  /**
   * Drain the same-tick mount AND release queues in one pass (ADR 0002 items 11 +
   * 12). First cancels same-path release+mount pairs (a React remount across a
   * page swap — {@link #rebindCancelledPair}); then flushes the unpaired releases
   * ({@link #flushRelease}); then sends the surviving mounts as a single `mount`
   * or `mount-batch` ({@link #sendSurvivingMounts}). Cancelled pairs never touch
   * the wire beyond an optional props patch.
   */
  async #flushSlotMounts(): Promise<void> {
    this.#slotFlushScheduled = false;
    const mounts = this.#pendingSlotMounts;
    this.#pendingSlotMounts = [];
    const releases = this.#pendingReleases;
    this.#pendingReleases = [];

    // Pair cancellation (ADR 0002 item 12): match each pending mount to a pending
    // release by PATH — the client can't know a mount's future instance id, but a
    // same-identity remount reuses the identity path. A matched pair is a React
    // remount across a page swap: cancel BOTH sides (no `release`, no `mount`) and
    // rebind the new caller to the still-registered instance. Unmatched releases
    // and mounts fall through to their normal wire sends, ORDERED release-then-
    // mount so the across-ticks path (already correct) is preserved.
    const releasesByPath = new Map<string, PendingRelease[]>();
    for (const r of releases) {
      const list = releasesByPath.get(r.path);
      if (list) list.push(r);
      else releasesByPath.set(r.path, [r]);
    }
    const cancelled = new Set<PendingRelease>();
    const survivingMounts: PendingSlotMount[] = [];
    for (const m of mounts) {
      const rel = releasesByPath.get(m.path)?.[0];
      // The store must still be registered to rebind onto — deferring the release
      // deregistration to flush time guarantees it is (a cancelled release never
      // deregisters). If it somehow isn't, don't cancel: let both sides flow.
      const store = rel ? this.#stores.get(rel.instance) : undefined;
      if (rel && store) {
        releasesByPath.get(m.path)?.shift();
        cancelled.add(rel);
        this.#rebindCancelledPair(rel, m, store);
      } else {
        survivingMounts.push(m);
      }
    }
    // Releases with no cancelling mount go out for real (normal unmount).
    for (const r of releases) if (!cancelled.has(r)) this.#flushRelease(r);
    await this.#sendSurvivingMounts(survivingMounts);
  }

  /**
   * Send the mounts that survived pair cancellation (ADR 0002 items 11 + 12):
   * ONE survivor keeps the unbatched `mount` shape (a regression pin — true even
   * when it survived because its sibling releases cancelled), 2+ become a single
   * `mount-batch` whose positional results settle each caller independently.
   */
  async #sendSurvivingMounts(pending: PendingSlotMount[]): Promise<void> {
    if (pending.length === 0) return;

    if (pending.length === 1) {
      // Regression pin: a lone mount stays the unbatched `mount` message.
      const p = pending[0] as PendingSlotMount;
      try {
        const parsed = await this.#mountRequest(p.path, p.props);
        this.#settleSlotMount(
          p,
          "redirect" in parsed ? parsed : { instance: parsed.instance, seq: 0 },
        );
      } catch (e) {
        p.reject(e);
      }
      return;
    }

    let results: MountBatchResult[];
    try {
      results = await this.#mountBatchRequest(pending);
    } catch (e) {
      // The whole POST failed (network/5xx) — no positional results exist, so
      // every queued mount rejects. Sibling isolation is a per-result property;
      // a transport failure is shared, exactly like the rpc POST path.
      for (const p of pending) p.reject(e);
      return;
    }
    pending.forEach((p, i) => {
      const result = results[i];
      if (!result) {
        // A short/malformed results array (protocol violation) — reject only the
        // unanswered entries; the answered siblings already settled.
        p.reject(new Error(`mount-batch response missing result at index ${i}`));
        return;
      }
      this.#settleSlotMount(p, result);
    });
  }

  /**
   * Flush a real `release` for a slot with no cancelling mount (ADR 0002 item 12):
   * drop the instance from the stream and deregister its store/deny sink/props —
   * the deregistration the immediate `release()` used to do inline, now deferred
   * to flush time so a same-tick mount could have rebound onto it instead.
   */
  #flushRelease(r: PendingRelease): void {
    void this.#control({ type: "release", instance: r.instance, stream: this.#streamId });
    this.#stores.delete(r.instance);
    this.#denySinks.delete(r.instance);
    this.#slotProps.delete(r.instance);
  }

  /**
   * Cancel a same-path release+mount pair (ADR 0002 item 12). The cancelled
   * release never deregistered, so the new caller rebinds to the SAME live
   * instance — its confirmed state, optimistic queue, and stream subscription all
   * survive the React remount. Two carry-overs are rewired for the new caller:
   * (1) the deny sink is cleared here (the rebound handle installs the new
   * caller's via `onDeny`); (2) **the stale-capability fix** — when the caller's
   * props differ from what the server last heard for this instance, forward
   * exactly ONE `url` patchProps. Item 8's dedup makes that guard + load-with-new-
   * props on the same instance, so a slot shared across pages (e.g. a chat panel
   * whose tools change per page) never keeps the previous page's props. Identical
   * props send nothing — a pure React remount is fully a no-op on the wire.
   */
  #rebindCancelledPair(rel: PendingRelease, mount: PendingSlotMount, store: LiveStore): void {
    this.#denySinks.delete(rel.instance);
    const nextCanon = canonicalProps(mount.props);
    if (nextCanon !== this.#slotProps.get(rel.instance)) {
      this.#slotProps.set(rel.instance, nextCanon);
      this.#sendUrl(rel.instance, mount.props);
    }
    mount.resolve(this.#slotHandle(mount.path, rel.instance, store));
  }

  /**
   * Settle one queued mount from its positional result (ADR 0002 item 11):
   * `{ redirect }` rejects with `redirect()` (the slot renders `fallback`),
   * `{ error }` rejects with an `Error`, and `{ instance }` builds the store +
   * stream join and resolves a {@link SlotHandle}. Isolated per entry — used for
   * both the single `mount` and each `mount-batch` result.
   */
  #settleSlotMount(p: PendingSlotMount, result: MountBatchResult): void {
    if ("redirect" in result) {
      // A mount deny (§10) surfaces to the caller as a thrown redirect.
      p.reject(redirect(result.redirect));
      return;
    }
    if ("error" in result) {
      p.reject(new Error(result.error.message || result.error.name || "mount failed"));
      return;
    }
    p.resolve(this.#buildSlotHandle(p.path, p.props, result.instance, p.meta));
  }

  /**
   * Build the {@link SlotHandle} for a successfully mounted slot instance and
   * join it to the live stream — the tail the single `mount` and every
   * `mount-batch` result share. On WS the socket *is* the stream, so a `mount`
   * frame warm-joins the just-mounted instance to it; on SSE the mount POST
   * already carried `stream`, so a `resync` fetches the fresh store's snapshot.
   */
  #buildSlotHandle(
    path: string,
    props: Record<string, unknown>,
    instance: string,
    meta?: Record<string, RpcMeta>,
  ): SlotHandle {
    const store = this.#makeStore<unknown, Record<string, unknown>>(instance, meta);
    this.#stores.set(instance, store as LiveStore);
    // Seed the pair-cancellation dedup baseline (ADR 0002 item 12): the props the
    // server now knows for this instance, so a later cancelled-pair rebind can
    // tell whether the remounting caller needs a `url` patch forwarded.
    this.#slotProps.set(instance, canonicalProps(props));
    if (this.#opts.transport === "ws" && this.#socketOpen && this.#socket) {
      // The socket *is* the stream: the control POST mounted the instance (and
      // surfaced any deny), but on WS the POST's `stream` id names no SSE
      // stream — so join the just-mounted instance to THIS socket with a `mount`
      // frame. `subscribeInstance` is idempotent (warm reuse) and resyncs it.
      this.#socket.send(JSON.stringify({ type: "mount", path, props }));
    } else {
      // SSE: the mount POST carried `stream`, so the server already joined the
      // instance to this stream — resync so the fresh store gets its snapshot.
      void this.#control({ type: "resync", instance });
    }
    return this.#slotHandle(path, instance, store as LiveStore);
  }

  /**
   * Build the {@link SlotHandle} surface over an already-registered store — the
   * tail shared by a fresh mount ({@link #buildSlotHandle}) and a cancelled-pair
   * rebind ({@link #rebindCancelledPair}). `patchProps` advances the item-12
   * props baseline so a later rebind dedups against the true last-sent value;
   * `release` defers (item 12) so a same-tick remount can cancel it.
   */
  #slotHandle(path: string, instance: string, store: LiveStore): SlotHandle {
    return {
      store,
      instance,
      path,
      patchProps: (next) => {
        this.#slotProps.set(instance, canonicalProps(next));
        this.#sendUrl(instance, next);
      },
      release: () => this.#enqueueRelease(path, instance),
      onDeny: (fn) => {
        this.#denySinks.set(instance, fn);
      },
    };
  }

  /**
   * POST a `mount-batch` naming this stream (ADR 0002 item 11): the per-entry
   * `{ path, props }` pairs in queue order, so the server's positional
   * `results[]` line up with {@link #pendingSlotMounts}. Throws on a non-ok
   * response (the whole batch failed); the caller rejects every queued entry.
   */
  async #mountBatchRequest(pending: PendingSlotMount[]): Promise<MountBatchResult[]> {
    const res = await this.#fetch()(`${this.#opts.base ?? ""}/__rpxd/control`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type: "mount-batch",
        stream: this.#streamId,
        mounts: pending.map((p) => ({ path: p.path, props: p.props })),
      }),
      credentials: "same-origin",
    });
    if (!res.ok) throw new Error(`mount-batch failed: ${res.status}`);
    return ((await res.json()) as { results: MountBatchResult[] }).results;
  }

  /**
   * Tier-2 soft reload (§7): a same-route path change. Mount the new instance,
   * join it to this live stream, swap the store to it, and release the old one —
   * the transport and app shell survive; only page state resets. A `setup`/
   * `guard` deny throws `redirect()` for the caller to soft-nav (§10).
   *
   * **Latest-wins**: two overlapping remounts share this one connection, so a
   * run tag (claimed synchronously, before the mount await) gates the store
   * swap — a remount whose `mountRequest` resolves after a newer one started
   * neither rebinds the store nor fires its redirect; it just releases the
   * instance it mounted so the loser doesn't leak.
   *
   * **Tier 3 rides this path (ADR 0002 item 9)**: a different route pattern no
   * longer builds a fresh connection — it remounts the new page instance over
   * this same stream and swaps the primary store. `meta` refreshes the primary
   * store's rpc metadata (`rpcMetaFromDef` of the new route) so it
   * validates/optimistics with the arriving page's contract.
   *
   * @example
   * ```ts
   * await conn.remount("/board/9", { filter: "open" }, rpcMetaFromDef(Board.def));
   * ```
   */
  async remount(
    path: string,
    search: Record<string, string>,
    meta?: Record<string, RpcMeta>,
  ): Promise<void> {
    const runId = ++this.#remountRunId;
    const parsed = await this.#mountRequest(path, search);
    const superseded = runId !== this.#remountRunId;
    if ("redirect" in parsed) {
      if (superseded) return; // a newer remount owns the outcome
      throw redirect(parsed.redirect);
    }
    if (superseded) {
      // A newer remount already (or will) bind the store; drop the instance we
      // mounted so it evicts instead of lingering subscribed to the stream.
      void this.#control({ type: "release", instance: parsed.instance, stream: this.#streamId });
      return;
    }
    const previous = this.#instance;
    this.#instance = parsed.instance;
    this.#stores.set(parsed.instance, this.#makeStore(parsed.instance, meta) as LiveStore);
    if (this.#opts.transport === "ws" && this.#socketOpen && this.#socket) {
      // The socket *is* the stream: join the new instance to it (warm-reuse of
      // the just-mounted instance) so its snapshot arrives on this socket. The
      // mountId correlates a deny that has no instance to answer on (#65).
      const mountId = `m${runId}`;
      this.#pendingMountId = mountId;
      // A page's URL query IS its props record — the mount control carries
      // `props` (ADR 0002 item 6), unified with the `url` message's vocabulary.
      this.#socket.send(JSON.stringify({ type: "mount", path, props: search, mountId }));
    } else {
      // SSE: the server joined the new instance to this stream by id at mount;
      // resync *after* the swap so the fresh store receives its full snapshot.
      void this.#control({ type: "resync", instance: parsed.instance });
    }
    void this.#control({ type: "release", instance: previous, stream: this.#streamId });
    // Deregister the outgoing page store so its late envelopes stop dispatching.
    // Guard against the shared-instance case (a re-mount of the same id).
    if (previous !== parsed.instance) this.#stores.delete(previous);
  }

  /** POST a `mount` naming this stream; returns the new instance id or a redirect. */
  async #mountRequest(
    path: string,
    search: Record<string, unknown>,
  ): Promise<{ instance: string } | { redirect: string }> {
    const res = await this.#fetch()(`${this.#opts.base ?? ""}/__rpxd/control`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      // The mount control carries `props` (ADR 0002 item 6).
      body: JSON.stringify({ type: "mount", path, props: search, stream: this.#streamId }),
      credentials: "same-origin",
    });
    if (!res.ok) throw new Error(`remount failed: ${res.status}`);
    return (await res.json()) as { instance: string } | { redirect: string };
  }

  /**
   * Route a `{ redirect }` control response (§10). A slot instance's deny fires
   * its `onDeny` sink; the primary's soft-navs the app. Both are sanitized to a
   * same-origin target.
   */
  async #consumeRedirect(res: Response, instance: string): Promise<void> {
    if (!(res.headers.get("content-type") ?? "").includes("application/json")) return;
    const body = (await res.json().catch(() => null)) as { redirect?: string } | null;
    if (body?.redirect) this.#routeRedirect(instance, body.redirect);
  }

  /**
   * A `redirect` envelope (WS runtime deny, §10) → the right sink. Order:
   * (1) the in-flight socket mount's correlation id (#65) — a mount denied
   * before any instance bound answers with `instance: ""`; (2) a slot's deny
   * sink, so a slot deny never soft-navs the app; (3) the primary instance →
   * app redirect. A stale mountId (superseded remount) matches none and drops,
   * per latest-wins (§7).
   */
  #handleRedirectEnvelope(env: Envelope): boolean {
    if (!env.redirect) return false;
    if (env.mountId !== undefined && env.mountId === this.#pendingMountId) {
      this.#pendingMountId = null;
      this.#navigateSafely(env.redirect);
      return true;
    }
    if (this.#denySinks.has(env.instance)) {
      this.#routeRedirect(env.instance, env.redirect);
      return true;
    }
    if (env.instance !== this.#instance) return false;
    this.#navigateSafely(env.redirect);
    return true;
  }

  /**
   * Send a sanitized redirect to a slot's deny sink when one is registered for
   * `instance`, else soft-nav the app. Unsafe targets are dropped (with a warn).
   */
  #routeRedirect(instance: string, target: string): void {
    const sink = this.#denySinks.get(instance);
    if (!sink) {
      this.#navigateSafely(target);
      return;
    }
    const safe = safeRedirectTarget(target);
    if (safe) sink(safe);
    else console.warn(`[rpxd] ignoring unsafe redirect target: ${target}`);
  }

  /**
   * Forward a server-supplied redirect only if it's a same-origin target. The
   * value comes off the wire and flows to the router / `window.location`, so a
   * cross-origin URL, a protocol-relative `//host`, or a `javascript:` scheme
   * would be an open-redirect / script-injection vector (§10) — those are
   * dropped with a warning rather than navigated to.
   */
  #navigateSafely(target: string): void {
    const safe = safeRedirectTarget(target);
    if (safe) this.#onRedirect?.(safe);
    else console.warn(`[rpxd] ignoring unsafe redirect target: ${target}`);
  }

  /** Close the transport. Server-side warm TTL takes it from here (§11). */
  close(): void {
    this.#closed = true;
    this.#source?.close();
    this.#source = undefined;
    this.#socket?.close();
    this.#socket = undefined;
    this.#socketOpen = false;
  }

  #fetch(): typeof fetch {
    return this.#opts.fetchImpl ?? fetch;
  }

  #send(batch: RpcBatch): void {
    if (this.#opts.transport === "ws") {
      // Unacked batches resend on reopen — dropping while closed is safe (§11).
      if (this.#socketOpen && this.#socket) this.#socket.send(JSON.stringify(batch));
      return;
    }
    void this.#fetch()(`${this.#opts.base ?? ""}/__rpxd/rpc`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(batch),
      credentials: "same-origin",
    }).catch(() => {
      // Delivery is at-least-once: the batch stays pending and is resent on
      // the next reconnect (§11). The transport is shared, so a POST failure
      // reflects on every store (ADR item 9).
      this.#setStatusAll("reconnecting");
    });
  }

  #control(msg: unknown): Promise<unknown> {
    if (this.#opts.transport === "ws" && this.#socketOpen && this.#socket) {
      this.#socket.send(JSON.stringify(msg));
      return Promise.resolve();
    }
    return this.#fetch()(`${this.#opts.base ?? ""}/__rpxd/control`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(msg),
      credentials: "same-origin",
    }).catch(() => undefined);
  }

  /**
   * Cold mount without SSR: ask the server to mount the route, then connect.
   */
  static async mount<S, Session = Record<string, unknown>>(
    path: string,
    search: Record<string, string>,
    opts: Omit<ConnectionOptions, "instance"> = {},
  ): Promise<LiveConnection<S, Session>> {
    const fetchImpl = opts.fetchImpl ?? fetch;
    const res = await fetchImpl(`${opts.base ?? ""}/__rpxd/control`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      // The mount control carries `props` (ADR 0002 item 6).
      body: JSON.stringify({ type: "mount", path, props: search }),
      credentials: "same-origin",
    });
    if (!res.ok) throw new Error(`mount failed: ${res.status}`);
    const parsed = (await res.json()) as { instance: string } | { redirect: string };
    // `mount` rejected with redirect() (§10) — surface it so the router can
    // soft-navigate to the target instead of connecting a broken instance.
    if ("redirect" in parsed) throw redirect(parsed.redirect);
    const conn = new LiveConnection<S, Session>({ ...opts, instance: parsed.instance });
    conn.connect();
    return conn;
  }
}
