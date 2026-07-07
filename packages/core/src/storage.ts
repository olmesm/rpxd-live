/**
 * Persistence seam (§9): write-through snapshots + the pubsub bus.
 * Adapters: `memory()` here (default); sqlite/redis/session live in their own
 * packages and implement the same interface.
 */

/** A broadcast in flight on the bus (§8). */
export interface BroadcastMessage {
  topic: string;
  event: string;
  payload: unknown;
  /** Instance id of the sender — used for exclude-self-by-default delivery. */
  senderId: string;
  /** When true, the sender's own instance also receives the event. */
  self: boolean;
}

/**
 * Topic bus carried by the persistence layer. In-process for `memory()`;
 * network-backed adapters (redis) fan out across nodes, which is what kills
 * instance affinity (§8).
 */
export interface PubSubBus {
  publish(msg: BroadcastMessage): void | Promise<void>;
  /** Returns an unsubscribe function. */
  subscribe(topic: string, subscriberId: string, fn: (msg: BroadcastMessage) => void): () => void;
}

/**
 * Whole-state snapshot — never a patch log (§9). `session` rides along for
 * session continuity; `state` is only reused within the same page lifetime
 * (cold wake re-runs `mount`).
 */
export interface Snapshot {
  state: unknown;
  session: unknown;
  seq: number;
  version: string;
}

/**
 * Storage adapter interface (§9): `get`/`set` of snapshots plus the pubsub
 * bus. All methods may be sync or async.
 *
 * @example
 * ```ts
 * import { memory } from "@rpxd/core";
 * const storage = memory(); // default adapter
 * ```
 */
export interface StorageAdapter {
  get(key: string): Promise<Snapshot | undefined> | Snapshot | undefined;
  set(key: string, snap: Snapshot): Promise<void> | void;
  delete(key: string): Promise<void> | void;
  bus: PubSubBus;
}

/** In-process pubsub bus used by `memory()` (and reusable by other adapters). */
export class LocalBus implements PubSubBus {
  #topics = new Map<string, Map<string, (msg: BroadcastMessage) => void>>();

  publish(msg: BroadcastMessage): void {
    const subs = this.#topics.get(msg.topic);
    if (!subs) return;
    for (const [id, fn] of subs) {
      if (!msg.self && id === msg.senderId) continue;
      fn(msg);
    }
  }

  subscribe(topic: string, subscriberId: string, fn: (msg: BroadcastMessage) => void): () => void {
    let subs = this.#topics.get(topic);
    if (!subs) {
      subs = new Map();
      this.#topics.set(topic, subs);
    }
    subs.set(subscriberId, fn);
    return () => {
      subs.delete(subscriberId);
      if (subs.size === 0) this.#topics.delete(topic);
    };
  }
}

/**
 * Default storage adapter: in-memory snapshots + in-process bus. State lives
 * for the lifetime of the server process; suitable for dev and single-node
 * deployments without durability needs.
 *
 * @example
 * ```ts
 * export default defineConfig({ storage: memory() });
 * ```
 */
export function memory(): StorageAdapter {
  const snapshots = new Map<string, Snapshot>();
  return {
    get: (key) => snapshots.get(key),
    set: (key, snap) => {
      snapshots.set(key, snap);
    },
    delete: (key) => {
      snapshots.delete(key);
    },
    bus: new LocalBus(),
  };
}
