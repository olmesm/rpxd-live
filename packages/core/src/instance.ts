/**
 * LiveInstance — the server-side runtime for one live object instance (§1).
 *
 * Handlers run off-queue (awaits never block the instance, §3); only
 * mutations serialize through the per-instance FIFO queue: patchState
 * flushes and `on` handlers. Each flush is one Immer draft → one patch
 * envelope, with string-suffix growth compiled to `append` ops (§2).
 */
import { createDraft, type Draft, enablePatches, finishDraft, setAutoFreeze } from "immer";
import { makeDiagnosticEmit, type RpxdDiagnosticSink } from "./diagnostics.ts";
import {
  type EventHandler,
  type HandlerCtx,
  isLongForm,
  type LiveDefinition,
  type Mutator,
  type PathParams,
  type RpcCtx,
  type RpcDef,
  type RpcLongForm,
} from "./live.ts";
import {
  type Envelope,
  type Patch,
  PROTOCOL_VERSION,
  type RpcBatch,
  type RpcCall,
} from "./protocol.ts";
import { SerialQueue } from "./queue.ts";
import { type RateLimit, RateLimitError, TokenBucket } from "./rate-limit.ts";
import { isRedirect } from "./redirect.ts";
import { validateInput } from "./standard-schema.ts";
import type { StorageAdapter } from "./storage.ts";
import { SupersededError } from "./supersede.ts";

enablePatches();
// Server state stays unfrozen: ctx.state's read-only proxy guards handler
// access (a proxy over a frozen target can't wrap nested reads — invariant),
// and skipping deep-freeze keeps high-frequency streaming flushes cheap.
setAutoFreeze(false);

/** Path prefix that routes a patch to the session slice instead of page state (§2). */
export const SESSION_PREFIX = "$session";

/** Reserved abort-group name for the URL loader (§7) — drives latest-wins. */
const LOAD_KEY = "$load";

/** Options for {@link LiveInstance.create}. */
export interface CreateInstanceOptions<S, Path extends string, Session> {
  /** Unique instance id — also the pubsub subscriber id (self-exclusion, §8). */
  id: string;
  def: LiveDefinition<S, Path, Session>;
  params: PathParams<Path>;
  session: Session;
  storage: StorageAdapter;
  /** Snapshot key in storage — one per (route, session). */
  storageKey: string;
  /** Applied to rpcs that don't declare their own `rateLimit` (§10). */
  defaultRateLimit?: RateLimit;
  /**
   * Max calls a single rpc batch may carry before it's rejected wholesale with
   * an error ack — no call runs (§11 ingress DoS guard). Defaults to
   * {@link DEFAULT_MAX_BATCH_CALLS}.
   */
  maxBatchCalls?: number;
  /**
   * App diagnostic sink (#73) for the instance's recovered errors — a failed
   * load, a flush/broadcast/snapshot fault, a throwing `on` handler. The server
   * injects its `onDiagnostic`-derived emit; when omitted, the instance falls
   * back to {@link defaultDiagnosticSink} (console) so standalone core keeps
   * working.
   */
  emit?: RpxdDiagnosticSink;
}

const ACK_CACHE_LIMIT = 64;

/**
 * Default cap on calls per rpc batch (§11 ingress DoS guard). Batches are
 * client-side same-tick coalescing — realistic ones are single digits — so a
 * few hundred is comfortable headroom while still bounding an attacker's
 * `calls` array. Raise via `maxBatchCalls` for apps that legitimately burst.
 */
export const DEFAULT_MAX_BATCH_CALLS = 256;

const READ_ONLY_HINT = "ctx.state is read-only — writes go through ctx.patchState(mut) (§3)";

/** Deep read-only view: reads pass through, writes throw with a pointer to patchState. */
function readOnlyView<T extends object>(target: T, cache: WeakMap<object, unknown>): T {
  const hit = cache.get(target);
  if (hit) return hit as T;
  const proxy = new Proxy(target, {
    get(t, prop, receiver) {
      const value = Reflect.get(t, prop, receiver);
      return typeof value === "object" && value !== null
        ? readOnlyView(value as object, cache)
        : value;
    },
    set() {
      throw new Error(READ_ONLY_HINT);
    },
    defineProperty() {
      throw new Error(READ_ONLY_HINT);
    },
    deleteProperty() {
      throw new Error(READ_ONLY_HINT);
    },
  });
  cache.set(target, proxy);
  return proxy as T;
}

/**
 * A live object instance. Create via {@link LiveInstance.create} — `setup` runs
 * once per identity (§12); cold wake always re-runs `setup`+`load` (§9).
 *
 * @example
 * ```ts
 * const inst = await LiveInstance.create({
 *   id: "inst-1", def: route.def, params: {}, session: {},
 *   storage: memory(), storageKey: "route:/:session-a",
 * });
 * inst.addListener((env) => send(env));
 * await inst.handleBatch(batch);
 * ```
 */
export class LiveInstance<S, Path extends string = string, Session = Record<string, unknown>> {
  readonly id: string;
  #def: LiveDefinition<S, Path, Session>;
  readonly #params: PathParams<Path>;
  readonly #storage: StorageAdapter;
  readonly #storageKey: string;
  readonly #version: string;
  readonly #defaultRateLimit: RateLimit | undefined;
  readonly #maxBatchCalls: number;
  /** App diagnostic sink (#73), wrapped so a throw from it never breaks a handler. */
  readonly #emitDiagnostic: RpxdDiagnosticSink;

  #state!: S;
  #session: Session;
  #seq = 0;
  readonly #queue = new SerialQueue();
  readonly #listeners = new Set<(env: Envelope) => void>();
  readonly #unsubs = new Map<string, () => void>();
  readonly #buckets = new Map<string, TokenBucket>();
  /** rpcName → live AbortControllers, for ctx.abort(name) and dispose (§3). */
  readonly #aborts = new Map<string, Set<AbortController>>();
  readonly #readOnlyCache = new WeakMap<object, unknown>();
  /**
   * Instance-global pending mutators: every commit point (chunk flush, final
   * flush, `on` handler) drains this first, so writes land in patchState
   * order across concurrent handlers — LWW by ordering (§1).
   */
  #pendingMuts: Mutator<S>[] = [];
  #flushScheduled = false;
  /** Monotonic load-run tag; a run's flushes are dropped once superseded (§7). */
  #loadRunId = 0;
  /**
   * Open first-paint gate for an in-flight {@link loadForRender} (§12): resolved
   * by the loader's first patch flush (or rejected by a pre-patch redirect, or
   * resolved when the run settles with no patch). `undefined` outside SSR.
   */
  #renderGate: { gate: Deferred<void>; runId: number } | undefined;
  /** Whether the current load run's loader has produced a patch — gates the render open (§12). */
  #loadWrote = false;
  /** Abort controller for the in-flight `authorize` guard — newer call cancels it (§10). */
  #authController: AbortController | undefined;
  /** rpcId → ack envelope, for at-least-once dedupe (§11). */
  readonly #acks = new Map<string, Envelope>();
  #disposed = false;

  private constructor(opts: CreateInstanceOptions<S, Path, Session>) {
    this.id = opts.id;
    this.#def = opts.def;
    this.#params = opts.params;
    this.#session = opts.session;
    this.#storage = opts.storage;
    this.#storageKey = opts.storageKey;
    this.#version = opts.def.version ?? "1";
    this.#defaultRateLimit = opts.defaultRateLimit;
    this.#maxBatchCalls = opts.maxBatchCalls ?? DEFAULT_MAX_BATCH_CALLS;
    this.#emitDiagnostic = makeDiagnosticEmit(opts.emit);
  }

  /**
   * Create an instance. Restores the session slice and seq base from a
   * version-matching snapshot (session continuity), then always re-runs
   * `setup` for page state (§9). Rejection propagates — the transport maps a
   * thrown `redirect` to a 302 and any other throw to the error route (§10).
   */
  static async create<S, Path extends string, Session>(
    opts: CreateInstanceOptions<S, Path, Session>,
  ): Promise<LiveInstance<S, Path, Session>> {
    const inst = new LiveInstance(opts);
    const snap = await opts.storage.get(opts.storageKey);
    if (snap && snap.version === inst.#version) {
      inst.#session = (snap.session as Session) ?? opts.session;
      inst.#seq = snap.seq;
    }
    inst.#state = opts.def.setup({
      params: opts.params,
      session: inst.#session,
      subscribe: (topic) => inst.#subscribeTopic(topic),
    });
    inst.#emit({ full: { state: inst.#state, session: inst.#session } });
    await inst.#writeThrough();
    return inst;
  }

  get state(): S {
    return this.#state;
  }

  get session(): Session {
    return this.#session;
  }

  get seq(): number {
    return this.#seq;
  }

  /** Number of attached envelope listeners — drives warm-TTL eviction (§11). */
  get subscriberCount(): number {
    return this.#listeners.size;
  }

  /** Attach an envelope listener (a connection). Returns detach. */
  addListener(fn: (env: Envelope) => void): () => void {
    this.#listeners.add(fn);
    return () => this.#listeners.delete(fn);
  }

  /**
   * Swap the live definition in place (§15 reducer HMR): new handlers apply
   * to subsequent rpcs/broadcasts while runtime state is preserved.
   */
  replaceDef(def: LiveDefinition<S, Path, Session>): void {
    this.#def = def;
  }

  /** Resolves once the instance queue has drained (useful for tests and eviction). */
  async idle(): Promise<void> {
    await this.#queue.idle();
  }

  /** Push a full snapshot envelope — gap recovery / late attach (§2). */
  resync(): void {
    this.#emit({ full: { state: this.#state, session: this.#session } });
  }

  /**
   * Execute an rpc batch (§6): calls run in order as plain async handlers;
   * same-tick patchState calls coalesce into flushes, and the final flush at
   * completion carries the ack (so its patches and idMap ride one envelope).
   * Resent batches (same `rpcId`) are re-acked, not re-run.
   */
  async handleBatch(batch: RpcBatch): Promise<void> {
    // Protocol-version gate (W1): the version rides each batch, so an
    // incompatible client is rejected up front — before dedupe or any handler
    // runs — through the same error-ack path an unknown rpc / validation
    // failure uses. Confirmed state is left untouched.
    if (batch.v !== PROTOCOL_VERSION) {
      await this.#ackError(
        batch.rpcId,
        {
          name: "ProtocolError",
          message: `protocol v${batch.v} unsupported (server: v${PROTOCOL_VERSION})`,
          rpc: "?",
        },
        "?",
        undefined,
        {},
      );
      return;
    }

    // Belt-and-braces crash-guard: `decodeBatch` (increment 2 wires this at the
    // transport boundary) already keeps a malformed `calls` from reaching here,
    // but `handleBatch` is also called directly (testing harness, future
    // callers) — so it must stay total on its own. A non-array `calls` used to
    // throw a bare TypeError reading `.length` below; fire-and-forget with no
    // `.catch()` at the boundary, that crashed the whole process on Node ≥24
    // (`--unhandled-rejections=throw`). Route through the same error-ack path
    // the version gate uses; an unparseable `rpcId` can't be correlated to a
    // waiting client, so there's nothing to ack — just return.
    if (!Array.isArray(batch.calls)) {
      if (typeof batch.rpcId !== "string") return;
      await this.#ackError(
        batch.rpcId,
        { name: "ProtocolError", message: "calls must be an array", rpc: "?" },
        "?",
        undefined,
        {},
      );
      return;
    }

    const cached = this.#acks.get(batch.rpcId);
    if (cached) {
      for (const fn of this.#listeners) fn(cached);
      return;
    }

    // Ingress DoS guard (§11): reject an over-cap batch wholesale before running
    // any call — an attacker's million-entry `calls` array never reaches a
    // handler. The error rides the ack channel like any other rpc failure.
    if (batch.calls.length > this.#maxBatchCalls) {
      await this.#ackError(
        batch.rpcId,
        {
          name: "PayloadTooLargeError",
          message: `rpc batch of ${batch.calls.length} exceeds maxBatchCalls (${this.#maxBatchCalls})`,
          rpc: "?",
        },
        "?",
        undefined,
        {},
      );
      return;
    }

    const idMap: Record<string, string> = {};

    let current: RpcCall | undefined;
    try {
      for (const call of batch.calls) {
        current = call;
        const { handler, payload } = await this.#prepare(call);
        // A call's writes stream to the instance-global pending list as they
        // happen (mutation order is instance-global FIFO, §3); a throw reports
        // via the error ack while sibling calls' committed writes stand.
        const controller = this.#trackAbort(call.rpc);
        const ctx = this.#makeHandlerCtx(idMap, controller.signal);
        try {
          await handler(payload, ctx);
        } finally {
          this.#untrackAbort(call.rpc, controller);
        }
      }
      await this.#flushFinal(batch.rpcId, idMap);
    } catch (e) {
      const rpcName = current?.rpc ?? "?";
      const error = {
        name: e instanceof Error ? e.name : "Error",
        message: e instanceof Error ? e.message : String(e),
        rpc: rpcName,
      };
      await this.#ackError(batch.rpcId, error, rpcName, current?.payload, idMap);
    }
  }

  /**
   * Run the auth guard for a set of search params (§10). **Awaitable** and kept
   * separate from `load` so the server can 302 *before* streaming/serving a
   * guarded page. A deny (`throw redirect`) — or any throw — propagates to the
   * caller. No-op when no `guard` is declared. A newer call aborts the prior
   * guard's `signal` (latest-wins for slow async auth lookups); the superseded
   * run then rejects with {@link SupersededError} — whatever its guard did.
   * Resolving instead would turn a swallowed deny into an allow (the caller
   * would proceed to load the denied URL), so supersession is explicit: callers
   * catch it and bail quietly — the winning run owns the outcome.
   */
  async authorize(search: Record<string, string | undefined>): Promise<void> {
    const guard = this.#def.guard;
    if (!guard || this.#disposed) return;
    this.#authController?.abort();
    const controller = new AbortController();
    this.#authController = controller;
    try {
      await guard(
        { params: this.#params, search },
        { params: this.#params, session: this.#session, signal: controller.signal },
      );
    } catch (e) {
      // A newer URL claimed the guard (this controller was aborted): its
      // outcome is stale — a deny here must not be swallowed into a resolve
      // (auth bypass), and a signal-respecting guard's `AbortError` must not
      // reach the transport as a spurious 500. Reject with the marker instead.
      if (controller.signal.aborted) throw new SupersededError();
      throw e;
    }
    // An allow from a superseded run is equally stale: its caller must not
    // load a URL the winning run never authorized.
    if (controller.signal.aborted) throw new SupersededError();
  }

  /**
   * Run the URL loader for a set of search params (§7) — the loader only;
   * `authorize` runs `guard` separately (the server awaits it first so a deny
   * 302s before streaming). Fires after `setup`+`authorize` and on every URL
   * change. The loader gets `{ params, search }`, writes page state through
   * `ctx.patchState`; loading/errors are userland state, no ack. **Latest-wins**:
   * a newer call aborts the prior run's `ctx.signal` and drops its late flushes.
   * A `redirect` thrown by the loader (§10) is re-thrown — only for the current
   * run — for an awaiting caller to map to a 302 / soft-nav.
   *
   * Awaits the **whole** run (used by tests and the testing harness for
   * determinism). SSR/reconcile uses {@link loadForRender}, which returns at the
   * first patch and streams the rest.
   */
  async load(search: Record<string, string | undefined>): Promise<void> {
    await this.#runLoad(search);
  }

  /**
   * SSR/reconcile entry (§12): start the loader and resolve once its **first
   * patch** has flushed — or the run settles with none. The unified render rule:
   * the first document carries state through the loader's first patch, and
   * everything after it streams. A loader whose first patch is synchronous (a
   * projection before its first `await`) renders immediately; one that `await`s
   * before patching blocks the first paint until that patch lands (crawlable,
   * data-complete). A `redirect` thrown before the first patch propagates (302 /
   * soft-nav); one thrown after is mid-stream — ignored, with a server-side log
   * (redirect before the first patch to navigate; per-URL denies belong in `guard`).
   */
  async loadForRender(search: Record<string, string | undefined>): Promise<void> {
    if (!this.#def.load || this.#disposed) return;
    const gate = makeDeferred<void>();
    const runId = this.#loadRunId + 1; // #runLoad claims exactly this tag
    // A newer render reconcile supersedes any pending one: resolve the outgoing
    // gate so its awaiter renders current state instead of hanging on a slot
    // this call is about to overwrite (concurrent reconciles share the instance).
    this.#renderGate?.gate.resolve();
    this.#renderGate = { gate, runId };
    // The remainder streams after the gate opens. #runLoad logs data throws and
    // rejects the gate with a pre-first-patch redirect (delivered to the await
    // below); the only rejection left here is a redirect thrown *after* the
    // first patch — no awaiter can map it, so log the drop instead of hiding it.
    void this.#runLoad(search).catch((e: unknown) => {
      if (isRedirect(e) && !gate.rejected) {
        this.#emitDiagnostic({
          category: "instance",
          type: "load-redirect-ignored",
          level: "warn",
          detail: { location: e.location },
          error: e,
        });
      }
    });
    await gate.promise;
  }

  async #runLoad(search: Record<string, string | undefined>): Promise<void> {
    const loader = this.#def.load;
    if (!loader || this.#disposed) return;

    // Latest-wins: cancel any in-flight run, then claim this run's tag.
    this.#abortRpc(LOAD_KEY);
    const runId = ++this.#loadRunId;
    // A run claimed by anything other than this render's own gate supersedes it
    // (e.g. a plain load() over an in-flight loadForRender): settle the orphan.
    this.#supersedeRenderGate(runId);
    this.#loadWrote = false;
    const controller = this.#trackAbort(LOAD_KEY);

    const idMap: Record<string, string> = {};
    const ctx = this.#makeHandlerCtx(idMap, controller.signal);
    // Drop flushes from a superseded run even when userland ignores the
    // signal — the run tag is the authority, the signal is the courtesy.
    const queue = ctx.patchState;
    (ctx as { patchState: (mut: Mutator<S>) => void }).patchState = (mut) => {
      if (runId !== this.#loadRunId) return;
      this.#loadWrote = true; // this run's loader has produced a patch (§12)
      queue(mut);
    };

    try {
      await loader({ params: this.#params, search }, ctx);
      if (runId === this.#loadRunId) await this.#flushChunk();
    } catch (e) {
      // Only the current run reacts — a superseded run (newer URL claimed the
      // tag) neither redirects nor logs. A redirect is control-flow (§10):
      // re-throw so the caller maps it to a 302 (SSR) / soft-nav (runtime). A
      // data throw is reported server-side.
      if (runId !== this.#loadRunId) return;
      if (isRedirect(e)) {
        this.#settleRenderGate(runId, e);
        throw e;
      }
      if (!controller.signal.aborted)
        this.#emitDiagnostic({
          category: "instance",
          type: "load-failed",
          level: "error",
          error: e,
        });
    } finally {
      this.#untrackAbort(LOAD_KEY, controller);
      // Run ended: if no patch ever opened the gate, render the setup skeleton.
      this.#settleRenderGate(runId);
    }
  }

  /** Open (or reject) an in-flight render gate for the current run only (§12). */
  #settleRenderGate(runId: number, redirect?: unknown): void {
    const pending = this.#renderGate;
    if (!pending || pending.runId !== runId) return;
    this.#renderGate = undefined;
    if (redirect !== undefined) pending.gate.reject(redirect);
    else pending.gate.resolve();
  }

  /**
   * Resolve a render gate left behind by an older run once `currentRunId` claims
   * the tag (§12) — the superseded reconcile renders current state rather than
   * hanging on a gate its run can no longer settle.
   */
  #supersedeRenderGate(currentRunId: number): void {
    const pending = this.#renderGate;
    if (!pending || pending.runId === currentRunId) return;
    this.#renderGate = undefined;
    pending.gate.resolve();
  }

  /**
   * Tear down: abort every in-flight handler's `ctx.signal` (§3), drain the
   * mutation queue, unsubscribe from all topics, write a final snapshot
   * (§11 eviction). Parked handlers resume against a disposed instance —
   * their late flushes are dropped.
   *
   * `persist` defaults to `true` (the write-through snapshot). Pass `false` to
   * drop the instance without persisting — used when an un-attached instance is
   * shed under memory pressure (a never-adopted scanner mount, #61), where the
   * snapshot is pure waste.
   */
  async dispose(persist = true): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const controllers of this.#aborts.values()) {
      for (const controller of controllers) controller.abort();
    }
    this.#aborts.clear();
    await this.#queue.idle();
    for (const unsub of this.#unsubs.values()) unsub();
    this.#unsubs.clear();
    this.#listeners.clear();
    if (persist) await this.#writeThrough();
  }

  // ---- internals ----------------------------------------------------------

  #makeCtx(idMap: Record<string, string>): RpcCtx<PathParams<Path>, Session> {
    return {
      params: this.#params,
      session: this.#session,
      broadcast: (topic, event, payload, opts) => {
        const msg = {
          topic,
          event,
          payload,
          senderId: this.id,
          self: opts?.self ?? false,
        };
        // Serialize delivery behind the mutation queue so patchState calls
        // issued before the broadcast are committed before receivers react.
        void this.#queue
          .run(() => this.#storage.bus.publish(msg))
          .catch((e) =>
            this.#emitDiagnostic({
              category: "instance",
              type: "broadcast-publish-failed",
              level: "error",
              error: e,
              detail: { topic: msg.topic, event: msg.event },
            }),
          );
      },
      resolveId: (tempId, realId) => {
        idMap[tempId] = realId;
      },
    };
  }

  #makeHandlerCtx(
    idMap: Record<string, string>,
    signal: AbortSignal,
  ): HandlerCtx<S, PathParams<Path>, Session> {
    const self = this;
    return {
      ...this.#makeCtx(idMap),
      get state() {
        return readOnlyView(self.#state as object, self.#readOnlyCache) as HandlerCtx<
          S,
          PathParams<Path>,
          Session
        >["state"];
      },
      patchState: (mut) => this.#queueMut(mut),
      signal,
      abort: (rpc) => this.#abortRpc(rpc),
    };
  }

  /** Buffer a mutator on the instance-global pending list; schedule the tick's chunk flush (§3). */
  #queueMut(mut: Mutator<S>): void {
    if (this.#disposed) return;
    this.#pendingMuts.push(mut);
    if (this.#flushScheduled) return;
    this.#flushScheduled = true;
    // Macrotask boundary = the coalescing tick: same-tick calls (including
    // across microtasks) share one flush; a handler completing in the same
    // tick drains the pending list first, so those patches ride the ack.
    setTimeout(() => {
      this.#flushScheduled = false;
      void this.#flushChunk();
    }, 0);
  }

  /** Mid-handler flush: no ack fields, emits only if something changed. */
  async #flushChunk(): Promise<void> {
    await this.#queue
      .run(async () => {
        if (this.#disposed || this.#pendingMuts.length === 0) return;
        const patches = this.#applyMuts(this.#pendingMuts.splice(0));
        if (patches.length > 0) {
          this.#emit({ patches });
          // The loader's first patch opens the SSR render gate (§12): the first
          // document carries state through here, the rest streams. Gate only on
          // the loader's own write — an unrelated rpc/broadcast flush landing
          // during a warm reconcile must not open the paint before load's data.
          if (this.#loadWrote) this.#settleRenderGate(this.#loadRunId);
        }
        await this.#writeThrough();
      })
      .catch((e) => {
        this.#emitDiagnostic({
          category: "instance",
          type: "flush-failed",
          level: "error",
          error: e,
        });
      });
  }

  /** Completion flush: drains the pending list, always emits the ack. */
  async #flushFinal(rpcId: string, idMap: Record<string, string>): Promise<void> {
    await this.#queue.run(async () => {
      if (this.#disposed) return;
      const patches = this.#applyMuts(this.#pendingMuts.splice(0));
      this.#emitAck({ patches, rpcId, ...this.#idMapField(idMap) });
      await this.#writeThrough();
    });
  }

  /** One draft over current state, all mutators, exact patches + append compile. */
  #applyMuts(muts: Mutator<S>[]): Patch[] {
    if (muts.length === 0) return [];
    const draft = createDraft(this.#state as object) as Draft<S>;
    try {
      for (const mut of muts) mut(draft);
    } catch (e) {
      this.#discard(draft);
      throw e;
    }
    let patches: Patch[] = [];
    let inverse: Patch[] = [];
    this.#state = finishDraft(draft, (p, inv) => {
      patches = p as Patch[];
      inverse = inv as Patch[];
    }) as S;
    return compileAppends(patches, inverse);
  }

  #trackAbort(rpc: string): AbortController {
    const controller = new AbortController();
    let set = this.#aborts.get(rpc);
    if (!set) {
      set = new Set();
      this.#aborts.set(rpc, set);
    }
    set.add(controller);
    return controller;
  }

  #untrackAbort(rpc: string, controller: AbortController): void {
    const set = this.#aborts.get(rpc);
    set?.delete(controller);
    if (set?.size === 0) this.#aborts.delete(rpc);
  }

  /** ctx.abort(name): abort every in-flight invocation of a named rpc (§3). */
  #abortRpc(rpc: string): void {
    const set = this.#aborts.get(rpc);
    if (!set) return;
    for (const controller of set) controller.abort();
  }

  #subscribeTopic(topic: string): void {
    if (this.#unsubs.has(topic)) return;
    const unsub = this.#storage.bus.subscribe(topic, this.id, (msg) => {
      const handler = this.#def.on?.[msg.event];
      if (!handler) return;
      void this.#queue
        .run(() => this.#runEventHandler(handler, msg.payload))
        .catch((e) => {
          // Broadcast handlers have no ack channel; a throw discards the
          // draft and is reported server-side only (§10).
          this.#emitDiagnostic({
            category: "instance",
            type: "event-handler-failed",
            level: "error",
            error: e,
            detail: { event: msg.event },
          });
        });
    });
    this.#unsubs.set(topic, unsub);
  }

  /**
   * `on` handlers are sync mutators (§8): one draft, one flush, no ack.
   * Pending patchState muts drain first so a sender's writes issued before
   * its broadcast are ordered before the reaction.
   */
  async #runEventHandler(
    // biome-ignore lint/suspicious/noExplicitAny: dispatched by event name — the payload shape is only known to the registered handler
    handler: EventHandler<S, any, PathParams<Path>, Session>,
    payload: unknown,
  ): Promise<void> {
    const ctx = this.#makeCtx({});
    // Commit any unrelated pending writes on their own draft FIRST (still
    // ordered before the reaction), so a throwing event handler discards only
    // its own mutation — not another rpc's buffered patchState writes.
    const pending = this.#pendingMuts.splice(0);
    if (pending.length > 0) {
      const pendingPatches = this.#applyMuts(pending);
      if (pendingPatches.length > 0) this.#emit({ patches: pendingPatches });
      await this.#writeThrough();
    }
    const patches = this.#applyMuts([(draft) => handler(draft, payload, ctx)]);
    if (patches.length > 0) this.#emit({ patches });
    await this.#writeThrough();
  }

  /** Resolve + gate one call: unknown rpc, rate limit, input validation. */
  async #prepare(call: RpcCall): Promise<{
    handler: RpcLongForm<S, unknown, PathParams<Path>, Session>["handler"];
    payload: unknown;
  }> {
    const def: RpcDef<S, PathParams<Path>, Session> | undefined = this.#def.rpc?.[call.rpc];
    if (!def) throw new Error(`Unknown rpc "${call.rpc}"`);

    const limit = (isLongForm(def) ? def.rateLimit : undefined) ?? this.#defaultRateLimit;
    if (limit) {
      let bucket = this.#buckets.get(call.rpc);
      if (!bucket) {
        bucket = new TokenBucket(limit);
        this.#buckets.set(call.rpc, bucket);
      }
      if (!bucket.take()) throw new RateLimitError(call.rpc);
    }

    let payload = call.payload;
    if (isLongForm(def) && def.input) {
      payload = await validateInput(def.input, payload, call.rpc);
    }
    return {
      handler: isLongForm(def) ? def.handler : def,
      payload,
    };
  }

  /**
   * Failure ack (§5): pending same-tick muts commit alongside the `onError`
   * mutator, and the combined patches ride the error ack.
   */
  async #ackError(
    rpcId: string,
    error: { name: string; message: string; rpc: string },
    rpcName: string,
    payload: unknown,
    idMap: Record<string, string>,
  ): Promise<void> {
    // Sibling calls' committed writes live in the pending list and still flush
    // with the error ack, alongside any `onError` repair below.
    const muts = this.#pendingMuts.splice(0);

    const def = this.#def.rpc?.[rpcName];
    const onError = def && isLongForm(def) ? def.onError : undefined;
    if (onError) {
      const ctx = this.#makeCtx(idMap);
      muts.push((draft) => onError(draft, error, payload, ctx));
    }

    let patches: Patch[] = [];
    if (muts.length > 0) {
      try {
        await this.#queue.run(async () => {
          patches = this.#applyMuts(muts);
          await this.#writeThrough();
        });
      } catch (e) {
        this.#emitDiagnostic({
          category: "instance",
          type: "on-error-threw",
          level: "error",
          error: e,
          detail: { rpc: rpcName },
        });
        patches = [];
      }
    }
    this.#emitAck({ patches, rpcId, error, ...this.#idMapField(idMap) });
  }

  /** Finish-and-drop a draft after a throw — immer requires finalization. */
  #discard(draft: Draft<S> | Draft<Session>): void {
    try {
      finishDraft(draft);
    } catch {
      // already finalized
    }
  }

  #idMapField(idMap: Record<string, string>): { idMap?: Record<string, string> } {
    return Object.keys(idMap).length > 0 ? { idMap } : {};
  }

  #emit(body: Omit<Envelope, "seq" | "instance">): Envelope {
    this.#seq += 1;
    const env: Envelope = { seq: this.#seq, instance: this.id, ...body };
    for (const fn of this.#listeners) fn(env);
    return env;
  }

  #emitAck(body: Omit<Envelope, "seq" | "instance"> & { rpcId: string }): void {
    const env = this.#emit(body);
    this.#acks.set(body.rpcId, env);
    if (this.#acks.size > ACK_CACHE_LIMIT) {
      const oldest = this.#acks.keys().next().value;
      if (oldest !== undefined) this.#acks.delete(oldest);
    }
  }

  async #writeThrough(): Promise<void> {
    try {
      await this.#storage.set(this.#storageKey, {
        state: this.#state,
        session: this.#session,
        seq: this.#seq,
        version: this.#version,
      });
    } catch (e) {
      this.#emitDiagnostic({
        category: "instance",
        type: "snapshot-write-failed",
        level: "error",
        error: e,
      });
    }
  }
}

/** A promise plus its resolve/reject handles — the render gate's open signal (§12). */
interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
  /** Whether `reject` ran — i.e. the rejection was delivered to the awaiter (§12). */
  readonly rejected: boolean;
}

function makeDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  let rejected = false;
  return {
    promise,
    resolve,
    reject: (reason?: unknown) => {
      rejected = true;
      reject(reason);
    },
    get rejected() {
      return rejected;
    },
  };
}

/**
 * Compile string-suffix growth into `append` ops (§2): a `replace` whose new
 * string extends the old one ships only the delta. Old values come from the
 * inverse patches, matched by path (immer's inverse array can carry extra
 * length-restoring entries, so index alignment isn't reliable).
 */
function compileAppends(patches: Patch[], inverse: Patch[]): Patch[] {
  if (patches.length === 0) return patches;
  const previous = new Map<string, unknown>();
  for (const inv of inverse) {
    if (inv.op === "replace") previous.set(JSON.stringify(inv.path), inv.value);
  }
  return patches.map((p) => {
    if (p.op !== "replace" || typeof p.value !== "string") return p;
    const old = previous.get(JSON.stringify(p.path));
    if (typeof old !== "string" || old.length === 0 || old.length >= p.value.length) return p;
    if (!p.value.startsWith(old)) return p;
    return { op: "append" as const, path: p.path, value: p.value.slice(old.length) };
  });
}
