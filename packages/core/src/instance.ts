/**
 * LiveInstance — the server-side runtime for one live object instance (§1).
 *
 * Handlers run off-queue (awaits never block the instance, §3); only
 * mutations serialize through the per-instance FIFO queue: patchState
 * flushes, `on` handlers, and the `params` reducer. Each flush is one
 * Immer draft → one atomic patch envelope, with string-suffix growth
 * compiled to `append` ops (§2).
 */
import { createDraft, type Draft, enablePatches, finishDraft, setAutoFreeze } from "immer";
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
import type { Envelope, Patch, RpcBatch, RpcCall } from "./protocol.ts";
import { SerialQueue } from "./queue.ts";
import { type RateLimit, RateLimitError, TokenBucket } from "./rate-limit.ts";
import { isRedirect } from "./redirect.ts";
import { validateInput } from "./standard-schema.ts";
import type { StorageAdapter } from "./storage.ts";

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
}

/**
 * Per-batch write buffer. Non-atomic batches push straight to the instance's
 * global pending list (mutation order is instance-global FIFO); `.atomic()`
 * batches buffer here instead — one flush at completion, discard on throw (§3).
 */
interface FlushBucket<S> {
  muts: Mutator<S>[];
  atomic: boolean;
}

const ACK_CACHE_LIMIT = 64;

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
   * Apply whatever mutators are currently staged, now, without waiting for the
   * scheduled coalescing tick (§3). Deterministic because the loader runs
   * synchronously up to its first `await` (§7) — so once `load` has handed
   * control back, its projection is already staged. Streaming SSR (§12) drains
   * it to serialize the projection chrome, then lets the awaited data stream.
   */
  async flushStaged(): Promise<void> {
    await this.#flushChunk();
  }

  /**
   * Execute an rpc batch (§6): calls run in order as plain async handlers;
   * same-tick patchState calls coalesce into flushes, and the final flush at
   * completion carries the ack (so its patches and idMap ride one envelope).
   * Resent batches (same `rpcId`) are re-acked, not re-run.
   */
  async handleBatch(batch: RpcBatch): Promise<void> {
    const cached = this.#acks.get(batch.rpcId);
    if (cached) {
      for (const fn of this.#listeners) fn(cached);
      return;
    }

    const idMap: Record<string, string> = {};

    let current: RpcCall | undefined;
    try {
      for (const call of batch.calls) {
        current = call;
        const { handler, payload, atomic } = await this.#prepare(call);
        // Atomicity is per-rpc (§3): each call gets its own buffer. A
        // non-atomic call's writes stream to the instance-global pending list
        // as they happen; an atomic call buffers here and is promoted (below)
        // only if it completes — so a throw rolls back this call alone, never a
        // sibling's committed writes.
        const bucket: FlushBucket<S> = { muts: [], atomic };
        const controller = this.#trackAbort(call.rpc);
        const ctx = this.#makeHandlerCtx(idMap, bucket, controller.signal);
        try {
          await handler(payload, ctx);
          if (atomic) this.#pendingMuts.push(...bucket.muts);
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
   * guard's `signal` (latest-wins for slow async auth lookups); a throw from a
   * run that a newer call already superseded is swallowed, so a signal-respecting
   * guard's `AbortError` never reaches the transport as a spurious 500.
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
      // A newer URL claimed the guard (this controller was aborted): its result
      // is stale, so drop any throw — including a signal-respecting guard's
      // `AbortError`. The live run propagates its redirect/auth error normally.
      if (controller.signal.aborted) return;
      throw e;
    }
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
   * The caller decides whether to await: the server streams (fire-and-forget)
   * by default and `await`s only when a route opts into blocking SSR (§12);
   * tests await for determinism.
   */
  async load(search: Record<string, string | undefined>): Promise<void> {
    const loader = this.#def.load;
    if (!loader || this.#disposed) return;

    // Latest-wins: cancel any in-flight run, then claim this run's tag.
    this.#abortRpc(LOAD_KEY);
    const runId = ++this.#loadRunId;
    const controller = this.#trackAbort(LOAD_KEY);

    const idMap: Record<string, string> = {};
    const bucket: FlushBucket<S> = { muts: [], atomic: false };
    const ctx = this.#makeHandlerCtx(idMap, bucket, controller.signal);
    // Drop flushes from a superseded run even when userland ignores the
    // signal — the run tag is the authority, the signal is the courtesy.
    const queue = ctx.patchState;
    (ctx as { patchState: (mut: Mutator<S>) => void }).patchState = (mut) => {
      if (runId === this.#loadRunId) queue(mut);
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
      if (isRedirect(e)) throw e;
      if (!controller.signal.aborted) console.error("[rpxd] load failed:", e);
    } finally {
      this.#untrackAbort(LOAD_KEY, controller);
    }
  }

  /**
   * Tear down: abort every in-flight handler's `ctx.signal` (§3), drain the
   * mutation queue, unsubscribe from all topics, write a final snapshot
   * (§11 eviction). Parked handlers resume against a disposed instance —
   * their late flushes are dropped.
   */
  async dispose(): Promise<void> {
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
    await this.#writeThrough();
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
          .catch((e) => console.error("[rpxd] broadcast publish failed:", e));
      },
      resolveId: (tempId, realId) => {
        idMap[tempId] = realId;
      },
    };
  }

  #makeHandlerCtx(
    idMap: Record<string, string>,
    bucket: FlushBucket<S>,
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
      patchState: (mut) => this.#queueMut(bucket, mut),
      signal,
      abort: (rpc) => this.#abortRpc(rpc),
    };
  }

  /** Buffer a mutator; schedule the tick's chunk flush unless atomic (§3). */
  #queueMut(bucket: FlushBucket<S>, mut: Mutator<S>): void {
    if (this.#disposed) return;
    if (bucket.atomic) {
      bucket.muts.push(mut);
      return;
    }
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
        if (patches.length > 0) this.#emit({ patches });
        await this.#writeThrough();
      })
      .catch((e) => {
        console.error("[rpxd] patchState flush failed:", e);
      });
  }

  /**
   * Completion flush: drains the pending list (which now includes any
   * successful atomic call's promoted writes), always emits the ack.
   */
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
          console.error(`[rpxd] on["${msg.event}"] handler failed:`, e);
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
    handler: EventHandler<S, PathParams<Path>, Session>,
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
    atomic: boolean;
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
      atomic: isLongForm(def) && def.atomic === true,
    };
  }

  /**
   * Failure ack (§5): atomic discards its whole buffer (rollback); otherwise
   * pending same-tick muts commit alongside the `onError` mutator, and the
   * combined patches ride the error ack.
   */
  async #ackError(
    rpcId: string,
    error: { name: string; message: string; rpc: string },
    rpcName: string,
    payload: unknown,
    idMap: Record<string, string>,
  ): Promise<void> {
    // The failing call's atomic buffer was never promoted (see handleBatch), so
    // its writes are already rolled back. Sibling calls' committed writes live
    // in the pending list and still flush with the error ack.
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
        console.error(`[rpxd] onError for rpc "${rpcName}" threw:`, e);
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
      console.error("[rpxd] snapshot write-through failed:", e);
    }
  }
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
