/**
 * Persistence seam (§9): write-through snapshots + the pubsub bus.
 * Adapters: `memory()` here (default); sqlite/redis/session live in their own
 * packages and implement the same interface.
 */
import { makeEmit, type RpxdEventSink } from "./events.ts";

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
  /**
   * Await this bus's in-flight LOCAL (this-process) deliveries — the test
   * harness's {@link StorageAdapter} `settled()` awaits it so a broadcast fired
   * during settling lands before assertions run. `publish` stays fire-and-forget
   * `void` (never block the instance, §8); `drain` is the only awaitable seam.
   * The guarantee is scoped to local delivery — true cross-node fan-out is not
   * modelled by a single-process bus. Optional so third-party buses stay
   * compatible; a synchronous bus (see {@link LocalBus}) resolves immediately.
   *
   * @example
   * ```ts
   * bus.publish(msg);   // fire-and-forget, returns void
   * await bus.drain?.(); // resolves once local delivery has settled
   * ```
   */
  drain?(): Promise<void>;
  /**
   * Inject the app's event sink (#73) so bus-internal faults — a throwing
   * subscriber, a dropped malformed message, a failed network publish — report
   * as structured `storage`-category events instead of bare `console.error`.
   * The server calls this once with its `onEvent`-derived emit; standalone the
   * bus falls back to {@link defaultEventSink}. Optional so pre-#73 adapters
   * still satisfy the interface.
   */
  setEmit?(emit: RpxdEventSink): void;
}

/**
 * Whole-state snapshot — never a patch log (§9). `session` rides along for
 * session continuity; `state` is only reused within the same page lifetime
 * (cold wake re-runs `setup`+`load`).
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
  /**
   * Release any resources the adapter *owns* (e.g. an sqlite `Database` handle),
   * called on graceful shutdown after snapshots are flushed. Optional: adapters
   * over a caller-provided client (redis) leave closing that client to the app's
   * `onShutdown` hook, since they don't own its lifecycle.
   */
  close?(): void | Promise<void>;
}

/**
 * In-process pubsub bus used by `memory()` (and reusable by other adapters).
 *
 * @example
 * ```ts
 * const bus = new LocalBus();
 * const unsub = bus.subscribe("room:1", "inst-a", (msg) => console.log(msg.event));
 * bus.publish({ topic: "room:1", event: "hi", payload: {}, senderId: "inst-b", self: false });
 * ```
 */
export class LocalBus implements PubSubBus {
  #topics = new Map<string, Map<string, (msg: BroadcastMessage) => void>>();
  #emit: RpxdEventSink = makeEmit();

  setEmit(emit: RpxdEventSink): void {
    this.#emit = makeEmit(emit);
  }

  publish(msg: BroadcastMessage): void {
    const subs = this.#topics.get(msg.topic);
    if (!subs) return;
    // Snapshot so an unsubscribe during delivery can't disturb iteration, and
    // isolate each subscriber: one throwing handler must not halt fan-out to
    // the rest, nor unwind into the broadcasting rpc handler.
    for (const [id, fn] of [...subs]) {
      if (!msg.self && id === msg.senderId) continue;
      try {
        fn(msg);
      } catch (err) {
        this.#emit({
          category: "storage",
          type: "subscriber-threw",
          level: "error",
          error: err,
          detail: { topic: msg.topic, subscriberId: id },
        });
      }
    }
  }

  /**
   * `LocalBus` delivers synchronously inside {@link publish}, so nothing is ever
   * in flight — `drain` is an already-resolved no-op, present to satisfy the
   * test harness's `settled()`.
   */
  async drain(): Promise<void> {}

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
