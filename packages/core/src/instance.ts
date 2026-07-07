/**
 * LiveInstance — the server-side runtime for one live object instance (§1).
 *
 * Owns the per-instance FIFO queue, Immer patch production, generator
 * segmenting, pubsub wiring, rate limiting, and write-through snapshots.
 */
import { createDraft, type Draft, enablePatches, finishDraft } from "immer";
import {
  type EventHandler,
  type GeneratorReducer,
  isGeneratorReducer,
  isLongForm,
  type LiveDefinition,
  type PathParams,
  type PlainReducer,
  type RpcCtx,
  type RpcDef,
} from "./live.ts";
import type { Envelope, Patch, RpcBatch, RpcCall } from "./protocol.ts";
import { SerialQueue } from "./queue.ts";
import { type RateLimit, RateLimitError, TokenBucket } from "./rate-limit.ts";
import { validateInput } from "./standard-schema.ts";
import type { StorageAdapter } from "./storage.ts";

enablePatches();

/** Path prefix that routes a patch to the session slice instead of page state (§2). */
export const SESSION_PREFIX = "$session";

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

interface GenEntry {
  gen: AsyncGenerator<void, void, void>;
  cancelled: boolean;
}

const ACK_CACHE_LIMIT = 64;

/**
 * A mounted live object. Create via {@link LiveInstance.create} — mount runs
 * exactly once per page load (§12); cold wake always re-mounts (§9).
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
  #segmentDraft: Draft<S> | undefined;
  readonly #activeGens = new Set<GenEntry>();
  readonly #listeners = new Set<(env: Envelope) => void>();
  readonly #unsubs = new Map<string, () => void>();
  readonly #buckets = new Map<string, TokenBucket>();
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
   * Mount a new instance. Restores the session slice and seq base from a
   * version-matching snapshot (session continuity), then always re-runs
   * `mount` for page state (§9). Rejection propagates — the transport maps it
   * to the error route (§10).
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
    inst.#state = await opts.def.mount(opts.params, {
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
   * Swap the live definition in place (§15 reducer HMR): new reducers apply
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
   * Execute an rpc batch (§6): one combined patch + one ack for plain calls;
   * generator calls stream their segment flushes and the ack follows
   * completion. Resent batches (same `rpcId`) are re-acked, not re-run.
   */
  async handleBatch(batch: RpcBatch): Promise<void> {
    const cached = this.#acks.get(batch.rpcId);
    if (cached) {
      for (const fn of this.#listeners) fn(cached);
      return;
    }

    const idMap: Record<string, string> = {};
    const errorOf = (e: unknown, rpc: string) => ({
      name: e instanceof Error ? e.name : "Error",
      message: e instanceof Error ? e.message : String(e),
      rpc,
    });

    // Group consecutive plain calls so they share one draft → one combined patch.
    const groups: { kind: "plain" | "gen"; calls: RpcCall[] }[] = [];
    for (const call of batch.calls) {
      const def = this.#def.rpc?.[call.rpc];
      const handler = def && (isLongForm(def) ? def.handler : def);
      const kind = handler && isGeneratorReducer(handler) ? "gen" : "plain";
      const last = groups[groups.length - 1];
      if (kind === "plain" && last?.kind === "plain") last.calls.push(call);
      else groups.push({ kind, calls: [call] });
    }

    let ackSent = false;
    for (let i = 0; i < groups.length; i++) {
      const group = groups[i] as { kind: "plain" | "gen"; calls: RpcCall[] };
      const isLast = i === groups.length - 1;
      const currentRpc = () => group.calls[group.calls.length - 1]?.rpc ?? "?";
      try {
        if (group.kind === "plain") {
          // The last plain group's flush doubles as the ack envelope.
          const ack = isLast ? { rpcId: batch.rpcId, idMap } : undefined;
          await this.#queue.run(() => this.#runPlainGroup(group.calls, idMap, ack));
          if (isLast) ackSent = true;
        } else {
          const call = group.calls[0] as RpcCall;
          await this.#runGeneratorCall(call, idMap);
        }
      } catch (e) {
        const failed = group.kind === "gen" ? (group.calls[0] as RpcCall) : undefined;
        const rpcName = failed?.rpc ?? currentRpc();
        await this.#ackError(batch.rpcId, errorOf(e, rpcName), rpcName, idMap, batch);
        return;
      }
    }

    if (!ackSent) {
      // Generator-terminated batch: segments already flushed; ack separately.
      this.#emitAck({ patches: [], rpcId: batch.rpcId, ...this.#idMapField(idMap) });
    }
  }

  /** Apply the search-param reducer to the session slice (§7) — no remount. */
  async setSearch(search: Record<string, string | undefined>): Promise<void> {
    const reducer = this.#def.params;
    if (!reducer) return;
    await this.#queue.run(async () => {
      const draft = createDraft(this.#session as object) as Draft<Session>;
      try {
        reducer(draft, search);
      } catch (e) {
        void this.#discard(draft);
        throw e;
      }
      let patches: Patch[] = [];
      this.#session = finishDraft(draft, (p) => {
        patches = p as Patch[];
      }) as Session;
      if (patches.length > 0) {
        this.#emit({ patches: patches.map((p) => ({ ...p, path: [SESSION_PREFIX, ...p.path] })) });
      }
      await this.#writeThrough();
    });
  }

  /**
   * Tear down: cancel running generators (their `finally` blocks run, §3),
   * unsubscribe from all topics, write a final snapshot (§11 eviction).
   */
  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    await this.#cancelGenerators();
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
        void this.#storage.bus.publish({
          topic,
          event,
          payload,
          senderId: this.id,
          self: opts?.self ?? false,
        });
      },
      resolveId: (tempId, realId) => {
        idMap[tempId] = realId;
      },
    };
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

  async #runEventHandler(handler: EventHandler<S, PathParams<Path>, Session>, payload: unknown) {
    const draft = createDraft(this.#state as object) as Draft<S>;
    try {
      await handler(draft, payload, this.#makeCtx({}));
    } catch (e) {
      void this.#discard(draft);
      throw e;
    }
    await this.#commitState(draft);
  }

  async #prepare(call: RpcCall): Promise<{
    handler: PlainReducer<S, unknown, PathParams<Path>, Session>;
    genHandler: GeneratorReducer<S, unknown, PathParams<Path>, Session>;
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
    const handler = isLongForm(def) ? def.handler : def;
    return {
      handler: handler as PlainReducer<S, unknown, PathParams<Path>, Session>,
      genHandler: handler as GeneratorReducer<S, unknown, PathParams<Path>, Session>,
      payload,
    };
  }

  async #runPlainGroup(
    calls: RpcCall[],
    idMap: Record<string, string>,
    ack?: { rpcId: string; idMap: Record<string, string> },
  ): Promise<void> {
    const draft = createDraft(this.#state as object) as Draft<S>;
    const ctx = this.#makeCtx(idMap);
    try {
      for (const call of calls) {
        const { handler, payload } = await this.#prepare(call);
        await handler(draft, payload, ctx);
      }
    } catch (e) {
      void this.#discard(draft);
      throw e;
    }
    await this.#commitState(
      draft,
      ack ? { rpcId: ack.rpcId, ...this.#idMapField(ack.idMap) } : undefined,
    );
  }

  async #runGeneratorCall(call: RpcCall, idMap: Record<string, string>): Promise<void> {
    // Validation + rate limiting happen inside the queue so ordering holds.
    const prepared = await this.#queue.run(() => this.#prepare(call));
    const ctx = this.#makeCtx(idMap);
    const gen = prepared.genHandler(() => this.#requireSegmentDraft(), call.payload, ctx);
    const entry: GenEntry = { gen, cancelled: false };
    this.#activeGens.add(entry);
    try {
      let done = false;
      while (!done) {
        done = await this.#queue.run(() => this.#genSegment(entry));
      }
    } finally {
      this.#activeGens.delete(entry);
    }
  }

  /** One segment: fresh draft → run to next yield/return → atomic flush (§3). */
  async #genSegment(entry: GenEntry): Promise<boolean> {
    const draft = createDraft(this.#state as object) as Draft<S>;
    this.#segmentDraft = draft;
    let result: IteratorResult<void, void>;
    try {
      result = await entry.gen.next();
    } catch (e) {
      void this.#discard(draft);
      throw e;
    } finally {
      this.#segmentDraft = undefined;
    }
    await this.#commitState(draft);
    return result.done ?? false;
  }

  #requireSegmentDraft(): Draft<S> {
    if (!this.#segmentDraft) {
      throw new Error(
        "getState() called outside a generator segment — never hold a getState() " +
          "reference across yield/await; call it again after resuming",
      );
    }
    return this.#segmentDraft;
  }

  /** Disconnect mid-run: `generator.return()` → `finally` blocks run (§3). */
  async #cancelGenerators(): Promise<void> {
    const entries = [...this.#activeGens];
    await Promise.all(
      entries.map((entry) =>
        this.#queue.run(async () => {
          if (entry.cancelled) return;
          entry.cancelled = true;
          const draft = createDraft(this.#state as object) as Draft<S>;
          this.#segmentDraft = draft;
          try {
            await entry.gen.return(undefined);
          } catch (e) {
            console.error("[rpxd] generator cleanup threw:", e);
          } finally {
            this.#segmentDraft = undefined;
          }
          await this.#commitState(draft);
        }),
      ),
    );
  }

  async #ackError(
    rpcId: string,
    error: { name: string; message: string; rpc: string },
    rpcName: string,
    idMap: Record<string, string>,
    batch: RpcBatch,
  ): Promise<void> {
    // onError runs as a queued reducer; its patches ride the error ack (§5).
    let patches: Patch[] = [];
    const def = this.#def.rpc?.[rpcName];
    const onError = def && isLongForm(def) ? def.onError : undefined;
    if (onError) {
      const payload = batch.calls.find((c) => c.rpc === rpcName)?.payload;
      try {
        await this.#queue.run(async () => {
          const draft = createDraft(this.#state as object) as Draft<S>;
          try {
            await onError(draft, error, payload, this.#makeCtx(idMap));
          } catch (e) {
            void this.#discard(draft);
            throw e;
          }
          patches = await this.#commitState(draft, undefined, /* emit */ false);
        });
      } catch (e) {
        console.error(`[rpxd] onError for rpc "${rpcName}" threw:`, e);
      }
    }
    this.#emitAck({ patches, rpcId, error, ...this.#idMapField(idMap) });
  }

  /** Finish a state draft, emit its envelope, write through storage. */
  async #commitState(
    draft: Draft<S>,
    ack?: { rpcId: string; idMap?: Record<string, string> },
    emit = true,
  ): Promise<Patch[]> {
    let patches: Patch[] = [];
    this.#state = finishDraft(draft, (p) => {
      patches = p as Patch[];
    }) as S;
    if (emit && ack) {
      this.#emitAck({ patches, rpcId: ack.rpcId, ...this.#idMapField(ack.idMap ?? {}) });
    } else if (emit && patches.length > 0) {
      this.#emit({ patches });
    }
    await this.#writeThrough();
    return patches;
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
