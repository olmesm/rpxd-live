/**
 * LiveStore — the client-side runtime (§4, §6, §2 client half).
 *
 * Holds `confirmed` (server truth) plus a queue of pending optimistic fns;
 * the rendered `view` is always `replay(pending, confirmed)` — optimistic
 * patches are never merged into confirmed state.
 */
import {
  type ConnectionStatus,
  type Envelope,
  type EnvelopeError,
  isLongForm,
  type LiveDefinition,
  type Patch,
  PROTOCOL_VERSION,
  type RpcBatch,
  type StandardSchemaV1,
  type SyncState,
  validateInput,
} from "@rpxd/core";
import { applyPatches, enablePatches, type Patch as ImmerPatch, produceWithPatches } from "immer";
import { matchIdMap } from "./id-map.ts";

enablePatches();

/**
 * Expand `append` ops (§2) into plain replaces against the base the patches
 * are about to apply to: new value = current string + delta. Returns `null`
 * when an append targets a non-string — a protocol error; the caller discards
 * the envelope and requests a resync.
 */
function expandAppends(base: unknown, patches: Patch[]): ImmerPatch[] | null {
  let out: Patch[] = patches;
  for (let i = 0; i < patches.length; i++) {
    const p = patches[i] as Patch;
    if (p.op !== "append") continue;
    let target = base;
    for (const key of p.path) {
      if (target === null || typeof target !== "object") return null;
      target = (target as Record<string | number, unknown>)[key];
    }
    if (typeof target !== "string" || typeof p.value !== "string") return null;
    if (out === patches) out = [...patches];
    out[i] = { op: "replace", path: p.path, value: target + p.value };
  }
  return out as ImmerPatch[];
}

/** Client-relevant slice of an rpc definition: optimistic fn + input schema. */
export interface RpcMeta {
  // biome-ignore lint/suspicious/noExplicitAny: meta is erased-type glue between def and store
  optimistic?: (state: any, payload: any, ctx: { tempId(): string }) => void;
  input?: StandardSchemaV1;
}

/**
 * Extract client-side rpc metadata (optimistic fns, input schemas) from a
 * live definition — the part of the def the client bundle actually uses.
 *
 * @example
 * ```ts
 * const store = new LiveStore({ instance, meta: rpcMetaFromDef(route.def), send, requestResync });
 * ```
 */
export function rpcMetaFromDef(
  // biome-ignore lint/suspicious/noExplicitAny: accepts any route's definition
  def: LiveDefinition<any, any, any>,
): Record<string, RpcMeta> {
  const meta: Record<string, RpcMeta> = {};
  for (const [name, rpc] of Object.entries(def.rpc ?? {})) {
    meta[name] = isLongForm(rpc) ? { optimistic: rpc.optimistic, input: rpc.input } : {};
  }
  return meta;
}

export type { ConnectionStatus, SyncState } from "@rpxd/core";

/** What the React layer renders — stable identity between store changes. */
export interface StoreSnapshot<S, Session> {
  state: S;
  session: Session;
  sync: SyncState;
  status: ConnectionStatus;
  keyOf: (id: string | number) => string;
}

interface PendingCall {
  rpc: string;
  payload: unknown;
  optimistic?: RpcMeta["optimistic"];
  resolve: () => void;
  reject: (e: unknown) => void;
}

interface PendingOp {
  rpcId: string;
  calls: PendingCall[];
  batch: RpcBatch;
  /** tempIds handed out to this op's optimistic fns, in call order (stable across replays). */
  tempIdList: string[];
  tempIds: Set<string>;
  tempIdCursor: number;
  /** Optimistic patches from the latest replay — input to position matching (§4). */
  lastPatches: Patch[];
  /** Replay threw → fn dropped silently; op still awaits its ack. */
  dead: boolean;
}

/** Constructor options for {@link LiveStore}. */
export interface LiveStoreOptions {
  instance: string;
  meta?: Record<string, RpcMeta>;
  /** Transport hook: deliver an rpc batch upstream. */
  send: (batch: RpcBatch) => void;
  /** Transport hook: a seq gap was detected; ask the server for a full snapshot. */
  requestResync: (lastSeq: number) => void;
}

let tempCounter = 0;
let rpcCounter = 0;

/**
 * Client-side store for one live object instance.
 *
 * @example
 * ```ts
 * const store = new LiveStore({ instance, meta: rpcMetaFromDef(def), send, requestResync });
 * store.applyEnvelope(envelopeFromServer);
 * await store.call("create", { name: "x" });
 * store.snapshot().state; // optimistic view
 * ```
 */
export class LiveStore<S = unknown, Session = Record<string, unknown>> {
  readonly #opts: LiveStoreOptions;
  readonly #meta: Record<string, RpcMeta>;

  #confirmedState: S = undefined as S;
  #confirmedSession: Session = undefined as Session;
  #seq = 0;
  #awaitingFull = true;

  #pending: PendingOp[] = [];
  #queue: PendingCall[] = [];
  #flushScheduled = false;

  /** realId → original tempId, for stable React keys across optimistic→confirmed (§4). */
  readonly #realToTemp = new Map<string, string>();

  #errors: EnvelopeError[] = [];
  #status: ConnectionStatus = "connecting";

  #view: S | undefined;
  #viewValid = false;
  #snapshot: StoreSnapshot<S, Session> | undefined;
  readonly #listeners = new Set<() => void>();

  constructor(opts: LiveStoreOptions) {
    this.#opts = opts;
    this.#meta = opts.meta ?? {};
  }

  /** Last applied envelope seq. */
  get seq(): number {
    return this.#seq;
  }

  /** Server-confirmed state, before optimistic replay. */
  get confirmed(): S {
    return this.#confirmedState;
  }

  /** Current connection status (§11). */
  get status(): ConnectionStatus {
    return this.#status;
  }

  /** Subscribe to store changes (useSyncExternalStore-compatible). */
  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  /** Current render snapshot — cached until the store changes. */
  snapshot = (): StoreSnapshot<S, Session> => {
    if (!this.#snapshot) {
      this.#snapshot = {
        state: this.#computeView(),
        session: this.#confirmedSession,
        sync: {
          pending: this.#pending.length > 0,
          inFlight: this.#pending.length,
          errors: this.#errors,
          clearErrors: this.clearErrors,
        },
        status: this.#status,
        keyOf: this.keyOf,
      };
    }
    return this.#snapshot;
  };

  /**
   * `keyOf(id)` (§4): returns the original tempId for optimistically-created
   * rows (stable React keys, no remount) and the id unchanged otherwise.
   */
  keyOf = (id: string | number): string => {
    const key = String(id);
    return this.#realToTemp.get(key) ?? key;
  };

  /** Transport status passthrough (§11). */
  setStatus(status: ConnectionStatus): void {
    this.#status = status;
    this.#invalidate();
  }

  /**
   * Drop surfaced errors (e.g. after the UI showed them). Arrow field (like
   * {@link keyOf}) so it can be handed out by reference into the `sync`
   * render prop — `sync.clearErrors` — without losing `this`.
   */
  clearErrors = (): void => {
    this.#errors = [];
    this.#invalidate();
  };

  /**
   * Invoke an rpc: validates client-side (pre-optimistic, §5), queues the
   * optimistic fn, and coalesces same-tick calls into one batch (§6). The
   * returned promise settles on ack.
   */
  call(rpc: string, payload: unknown = {}): Promise<void> {
    const meta = this.#meta[rpc];
    return new Promise<void>((resolve, reject) => {
      const enqueue = (validated: unknown) => {
        this.#queue.push({
          rpc,
          payload: validated,
          optimistic: meta?.optimistic,
          resolve,
          reject,
        });
        if (!this.#flushScheduled) {
          this.#flushScheduled = true;
          queueMicrotask(() => this.#flush());
        }
      };
      if (meta?.input) {
        Promise.resolve(validateInput(meta.input, payload, `rpc "${rpc}"`)).then(
          enqueue,
          (e: Error) => {
            this.#errors.push({ name: e.name, message: e.message, rpc });
            this.#invalidate();
            reject(e);
          },
        );
      } else {
        enqueue(payload);
      }
    });
  }

  /** Typed-ish convenience facade: `store.rpc.create({ name })`. */
  readonly rpc: Record<string, (payload?: unknown) => Promise<void>> = new Proxy(
    {},
    {
      get: (_target, name: string) => (payload?: unknown) => this.call(name, payload ?? {}),
    },
  );

  /** Apply a downstream envelope per the protocol rules (§2). */
  applyEnvelope(env: Envelope): void {
    // The stream multiplexes every instance of the session (§2) — only this
    // store's instance is ours to apply.
    if (env.instance !== this.#opts.instance) return;
    if (env.full) {
      this.#confirmedState = env.full.state as S;
      this.#confirmedSession = env.full.session as Session;
      this.#seq = env.seq;
      this.#awaitingFull = false;
      if (env.rpcId) this.#settleOp(env);
      this.#invalidate();
      return;
    }

    if (env.seq <= this.#seq) {
      // Stale/re-acked envelope: patches are already reflected in confirmed
      // state (or superseded by a full), but the ack still settles its op.
      if (env.rpcId) this.#settleOp(env);
      this.#invalidate();
      return;
    }

    if (this.#awaitingFull || env.seq > this.#seq + 1) {
      // Gap: stop applying patches, request recovery; acks still settle so
      // pending fns don't wedge (§2).
      if (!this.#awaitingFull) {
        this.#awaitingFull = true;
        this.#opts.requestResync(this.#seq);
      }
      if (env.rpcId) this.#settleOp(env);
      this.#invalidate();
      return;
    }

    // In-order patch envelope. The envelope is untrusted wire data, so any
    // structural corruption (non-iterable patches, a bad path, an append on a
    // non-string, §2) discards the whole frame and recovers via resync rather
    // than throwing into the transport or wedging the acking rpc.
    if (env.patches && env.patches.length > 0) {
      try {
        const sessionPatches: Patch[] = [];
        const statePatches: Patch[] = [];
        for (const p of env.patches) {
          if (p.path[0] === "$session") sessionPatches.push({ ...p, path: p.path.slice(1) });
          else statePatches.push(p);
        }
        const stateExpanded = expandAppends(this.#confirmedState, statePatches);
        const sessionExpanded = expandAppends(this.#confirmedSession ?? {}, sessionPatches);
        if (!stateExpanded || !sessionExpanded) {
          this.#recoverFromBadFrame(env);
          return;
        }
        if (stateExpanded.length > 0) {
          this.#confirmedState = applyPatches(this.#confirmedState as object, stateExpanded) as S;
        }
        if (sessionExpanded.length > 0) {
          this.#confirmedSession = applyPatches(
            (this.#confirmedSession ?? {}) as object,
            sessionExpanded,
          ) as Session;
        }
      } catch {
        this.#recoverFromBadFrame(env);
        return;
      }
    }
    this.#seq = env.seq;
    if (env.rpcId) this.#settleOp(env);
    this.#invalidate();
  }

  /** A corrupt/unapplyable frame: request recovery and settle the ack so the rpc can't wedge. */
  #recoverFromBadFrame(env: Envelope): void {
    this.#awaitingFull = true;
    this.#opts.requestResync(this.#seq);
    if (env.rpcId) this.#settleOp(env);
    this.#invalidate();
  }

  /** Resend unacked batches after reconnect — server dedupes by rpcId (§11). */
  resendUnacked(): void {
    for (const op of this.#pending) this.#opts.send(op.batch);
  }

  // ---- internals ----------------------------------------------------------

  #flush(): void {
    this.#flushScheduled = false;
    if (this.#queue.length === 0) return;
    const calls = this.#queue;
    this.#queue = [];
    const rpcId = `c${++rpcCounter}`;
    const batch: RpcBatch = {
      v: PROTOCOL_VERSION,
      instance: this.#opts.instance,
      rpcId,
      calls: calls.map((c) => ({ rpc: c.rpc, payload: c.payload })),
    };
    this.#pending.push({
      rpcId,
      calls,
      batch,
      tempIdList: [],
      tempIds: new Set(),
      tempIdCursor: 0,
      lastPatches: [],
      dead: false,
    });
    this.#opts.send(batch);
    this.#invalidate();
  }

  #settleOp(env: Envelope): void {
    const idx = this.#pending.findIndex((op) => op.rpcId === env.rpcId);
    if (idx === -1) return;
    const op = this.#pending[idx] as PendingOp;
    this.#pending.splice(idx, 1);

    if (env.error) {
      // Error → drop the fn: rollback is free because view = replay (§4).
      this.#errors.push(env.error);
      for (const call of op.calls) call.reject(new Error(env.error.message));
      return;
    }

    // Ack → link ids (position matching + server escape hatch), drop the fn.
    // The envelope is untrusted wire data and the op is already spliced out
    // above, so a throw here (corrupt patches shape) must not escape — every
    // pending op settles; id linking is best-effort and a resync restores
    // truth for a frame this corrupt.
    try {
      const ackPatches = Array.isArray(env.patches) ? env.patches : [];
      const matched = matchIdMap(op.lastPatches, ackPatches, op.tempIds);
      for (const [tempId, realId] of Object.entries({ ...matched, ...env.idMap })) {
        this.#realToTemp.set(realId, tempId);
      }
    } catch {
      // linking skipped — keyOf falls back to real ids
    }
    for (const call of op.calls) call.resolve();
  }

  #computeView(): S {
    if (this.#viewValid) return this.#view as S;
    let base = this.#confirmedState;
    for (const op of this.#pending) {
      if (op.dead) continue;
      op.tempIdCursor = 0;
      const ctx = {
        tempId: () => {
          const i = op.tempIdCursor++;
          const existing = op.tempIdList[i];
          if (existing) return existing;
          const fresh = `__rpxd_tmp_${++tempCounter}`;
          op.tempIdList.push(fresh);
          op.tempIds.add(fresh);
          return fresh;
        },
      };
      try {
        const [next, patches] = produceWithPatches(base as object, (draft: unknown) => {
          for (const call of op.calls) {
            call.optimistic?.(draft, call.payload, ctx);
          }
        });
        op.lastPatches = patches as Patch[];
        base = next as S;
      } catch {
        // Replay threw (e.g. row deleted by another user) → drop silently (§4).
        op.dead = true;
        op.lastPatches = [];
      }
    }
    this.#view = base;
    this.#viewValid = true;
    return base;
  }

  #invalidate(): void {
    this.#viewValid = false;
    this.#snapshot = undefined;
    for (const fn of this.#listeners) fn();
  }
}
