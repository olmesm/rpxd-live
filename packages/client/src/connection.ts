/**
 * LiveConnection (§11): wires a {@link LiveStore} to the server transport —
 * SSE downstream (`EventSource` auto-reconnect), HTTP POST upstream.
 * Connections are disposable; state is not.
 */
import { type Envelope, type RpcBatch, redirect } from "@rpxd/core";
import { LiveStore, type RpcMeta } from "./store.ts";

/** The slice of `EventSource` the connection uses — injectable for tests. */
export interface EventSourceLike {
  addEventListener(type: string, listener: (event: { data: string }) => void): void;
  close(): void;
}

/** The slice of `WebSocket` the connection uses — injectable for tests (§11 ws opt-in). */
export interface WebSocketLike {
  addEventListener(type: string, listener: (event: { data?: unknown }) => void): void;
  send(data: string): void;
  close(): void;
}

const WS_BACKOFF_BASE_MS = 1000;
const WS_BACKOFF_CAP_MS = 30_000;

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
  /** The instance the store is currently bound to — swapped by a tier-2 remount (§7). */
  #instance: string;
  /** Client-owned stream id: names this connection's stream for late-mount/release (§7). */
  readonly #streamId = randomId();
  /** Monotonic remount tag — a superseded tier-2 remount must not rebind the store (§7). */
  #remountRunId = 0;
  #store: LiveStore<S, Session>;
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
    this.#store = this.#makeStore(opts.instance);
    if (opts.bootstrap) {
      // Seed confirmed state from the SSR snapshot — no connect spinner (§12).
      this.#store.applyEnvelope({
        seq: opts.bootstrap.seq,
        instance: opts.instance,
        full: opts.bootstrap.snapshot as { state: unknown; session: unknown },
      });
    }
  }

  /** The store for the currently-bound instance. A tier-2 remount swaps it (§7). */
  get store(): LiveStore<S, Session> {
    return this.#store;
  }

  /** Install/replace the runtime-redirect sink (§10) — the app shell wires it to soft-nav. */
  setRedirectSink(fn: (location: string) => void): void {
    this.#onRedirect = fn;
  }

  /** Build a store bound to `instance`; its resync/rpc target that exact id. */
  #makeStore(instance: string): LiveStore<S, Session> {
    return new LiveStore<S, Session>({
      instance,
      meta: this.#opts.meta,
      send: (batch) => this.#send(batch),
      requestResync: () => this.#control({ type: "resync", instance }),
    });
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
    this.store.setStatus("connecting");

    source.addEventListener("open", () => {
      const reconnected = this.#everOpened;
      this.#everOpened = true;
      this.store.setStatus("live");
      if (reconnected) {
        // Unacked optimistic rpcs are resent with their original ids —
        // the server dedupes (§11).
        this.store.resendUnacked();
      }
    });
    source.addEventListener("env", (event) => {
      const env = JSON.parse(event.data) as Envelope;
      if (this.#handleRedirectEnvelope(env)) return;
      this.store.applyEnvelope(env);
      if (this.store.status !== "live") this.store.setStatus("live");
    });
    source.addEventListener("error", () => {
      this.store.setStatus("reconnecting");
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
    this.store.setStatus(this.#everOpened ? "reconnecting" : "connecting");

    socket.addEventListener("open", () => {
      const reconnected = this.#everOpened;
      this.#everOpened = true;
      this.#socketOpen = true;
      this.#retryAttempt = 0;
      this.store.setStatus("live");
      if (reconnected) this.store.resendUnacked();
    });
    socket.addEventListener("message", (event) => {
      const env = JSON.parse(String(event.data)) as Envelope;
      if (this.#handleRedirectEnvelope(env)) return;
      this.store.applyEnvelope(env);
      if (this.store.status !== "live") this.store.setStatus("live");
    });
    const retry = () => {
      if (this.#socket !== socket) return;
      this.#socket = undefined;
      this.#socketOpen = false;
      if (this.#closed) return;
      this.store.setStatus("reconnecting");
      // Exponential backoff with jitter (§11): the delay lands in
      // [window/2, window], window doubling per attempt up to the cap —
      // spreads a fleet of clients after a server bounce.
      const window = Math.min(WS_BACKOFF_CAP_MS, WS_BACKOFF_BASE_MS * 2 ** this.#retryAttempt);
      this.#retryAttempt += 1;
      const delay = window / 2 + Math.random() * (window / 2);
      setTimeout(() => this.#connectWs(), delay);
    };
    socket.addEventListener("close", retry);
    socket.addEventListener("error", () => {
      this.store.setStatus("reconnecting");
    });
  }

  /**
   * Tier-1 search change (§7): rerun `guard`+`load` for a new URL over the same
   * instance — no `setup`, state preserved (keepPreviousData). A `guard` deny
   * comes back as `{ redirect }` (SSE control response) or a `redirect` envelope
   * (WS) and is routed to `onRedirect` for a soft-nav (§10).
   */
  patchSearch(search: Record<string, string>): void {
    const instance = this.#instance;
    if (this.#opts.transport === "ws" && this.#socketOpen && this.#socket) {
      // A WS deny arrives as a `redirect` envelope on the socket (see message).
      this.#socket.send(JSON.stringify({ type: "url", instance, search }));
      return;
    }
    void this.#control({ type: "url", instance, search }).then((res) => {
      if (res instanceof Response && res.ok) void this.#consumeRedirect(res);
    });
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
   */
  async remount(path: string, search: Record<string, string>): Promise<void> {
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
    this.#store = this.#makeStore(parsed.instance);
    if (this.#opts.transport === "ws" && this.#socketOpen && this.#socket) {
      // The socket *is* the stream: join the new instance to it (warm-reuse of
      // the just-mounted instance) so its snapshot arrives on this socket.
      this.#socket.send(JSON.stringify({ type: "mount", path, search }));
    } else {
      // SSE: the server joined the new instance to this stream by id at mount;
      // resync *after* the swap so the fresh store receives its full snapshot.
      void this.#control({ type: "resync", instance: parsed.instance });
    }
    void this.#control({ type: "release", instance: previous, stream: this.#streamId });
  }

  /** POST a `mount` naming this stream; returns the new instance id or a redirect. */
  async #mountRequest(
    path: string,
    search: Record<string, string>,
  ): Promise<{ instance: string } | { redirect: string }> {
    const res = await this.#fetch()(`${this.#opts.base ?? ""}/__rpxd/control`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "mount", path, search, stream: this.#streamId }),
      credentials: "same-origin",
    });
    if (!res.ok) throw new Error(`remount failed: ${res.status}`);
    return (await res.json()) as { instance: string } | { redirect: string };
  }

  /** Route a `{ redirect }` control response to `onRedirect` (§10). */
  async #consumeRedirect(res: Response): Promise<void> {
    if (!(res.headers.get("content-type") ?? "").includes("application/json")) return;
    const body = (await res.json().catch(() => null)) as { redirect?: string } | null;
    if (body?.redirect) this.#navigateSafely(body.redirect);
  }

  /** A `redirect` envelope (WS runtime deny, §10) for the bound instance → soft-nav. */
  #handleRedirectEnvelope(env: Envelope): boolean {
    if (!env.redirect || env.instance !== this.#instance) return false;
    this.#navigateSafely(env.redirect);
    return true;
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
      // the next reconnect (§11).
      this.store.setStatus("reconnecting");
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
      body: JSON.stringify({ type: "mount", path, search }),
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
