/**
 * Redis storage adapter (§9): durable snapshots + a network pubsub bus.
 * The bus crossing nodes is what kills instance affinity — any node hosts
 * any session (§8).
 *
 * Takes a minimal client interface rather than depending on a specific
 * redis package: node-redis (`createClient`) and ioredis both satisfy it
 * with a thin wrapper.
 *
 * @packageDocumentation
 */
import {
  type BroadcastMessage,
  makeEmit,
  type PubSubBus,
  type RpxdEventSink,
  type Snapshot,
  type StorageAdapter,
} from "@rpxd/core";

/** The slice of a redis client rpxd needs. Sync returns are fine for fakes. */
export interface RedisLikeClient {
  get(key: string): Promise<string | null> | string | null;
  set(key: string, value: string): Promise<unknown> | unknown;
  del(key: string): Promise<unknown> | unknown;
  publish(channel: string, message: string): Promise<unknown> | unknown;
  /** Subscribe to a channel; returns an unsubscribe function. */
  subscribe(
    channel: string,
    onMessage: (message: string) => void,
  ): (() => void) | Promise<() => void>;
}

/** Options for {@link redis}. */
export interface RedisStorageOptions {
  /** Key/channel prefix. Default `rpxd:`. */
  prefix?: string;
}

/** One local subscriber riding a shared channel entry (see {@link ChannelEntry}). */
interface ChannelSubscriber {
  subscriberId: string;
  fn: (msg: BroadcastMessage) => void;
}

/**
 * Ref-counting state for one low-level redis channel (§62): every local
 * subscriber to the same topic shares a single `client.subscribe` call and a
 * single `JSON.parse` per delivered message, fanned out to `subscribers`.
 * `unsub`/`cancelled` mirror the single-subscriber `unsub`/`cancelled` pair
 * this replaced, just promoted to channel granularity so a subscriber leaving
 * before the pending `client.subscribe` resolves still tears it down once it
 * does.
 */
interface ChannelEntry {
  subscribers: Set<ChannelSubscriber>;
  unsub: (() => void) | undefined;
  cancelled: boolean;
}

class RedisBus implements PubSubBus {
  // Plain fields (not parameter properties) so the source stays erasable —
  // Node runs it under default, unflagged TypeScript stripping.
  private readonly client: RedisLikeClient;
  private readonly prefix: string;
  private readonly channels = new Map<string, ChannelEntry>();
  private emit: RpxdEventSink = makeEmit();
  // In-flight publishes, tracked so the test harness's settled() can await that
  // the PUBLISH commands it fired have been accepted (and local subscribers on
  // this node notified) — never remote-node processing, which is out of scope.
  private readonly pending = new Set<Promise<void>>();
  constructor(client: RedisLikeClient, prefix: string) {
    this.client = client;
    this.prefix = prefix;
  }

  setEmit(emit: RpxdEventSink): void {
    this.emit = makeEmit(emit);
  }

  publish(msg: BroadcastMessage): void {
    // Surface (rather than drop) a publish failure: a bare `void` on a
    // rejecting promise is an unhandled rejection, which crashes Node under the
    // default --unhandled-rejections=throw.
    const p = Promise.resolve(
      this.client.publish(`${this.prefix}bus:${msg.topic}`, JSON.stringify(msg)),
    )
      .then(() => {})
      .catch((err) => {
        this.emit({
          category: "storage",
          type: "redis-publish-failed",
          level: "error",
          error: err,
          detail: { topic: msg.topic },
        });
      })
      .finally(() => {
        this.pending.delete(p);
      });
    // Track without awaiting: publish stays fire-and-forget `void` (§8). Only
    // drain() below awaits these, so a failing publish is already caught and
    // never re-thrown at a drain() awaiter.
    this.pending.add(p);
  }

  /**
   * Await the PUBLISH commands fired so far to be accepted (and local
   * subscribers notified). Scoped to this node's delivery — cross-node
   * processing is not, and cannot be, awaited here. See {@link PubSubBus.drain}.
   */
  async drain(): Promise<void> {
    await Promise.all([...this.pending]);
  }

  subscribe(topic: string, subscriberId: string, fn: (msg: BroadcastMessage) => void): () => void {
    const channel = `${this.prefix}bus:${topic}`;
    const subscriber: ChannelSubscriber = { subscriberId, fn };
    const isFirstLocalSubscriber = !this.channels.has(channel);
    const entry: ChannelEntry = this.channels.get(channel) ?? {
      subscribers: new Set(),
      unsub: undefined,
      cancelled: false,
    };

    if (isFirstLocalSubscriber) {
      this.channels.set(channel, entry);
      // Like publish above: a rejecting subscribe (redis unreachable at instance
      // mount) must be caught, not left as an unhandled rejection. `entry.unsub`
      // stays undefined, so every subscriber's returned unsubscribe remains a
      // safe no-op. Issued exactly once per channel — later local subscribers
      // just join `entry.subscribers` below, whether they arrive before or
      // after this promise settles.
      Promise.resolve(
        this.client.subscribe(channel, (raw) => {
          // The channel carries untrusted bytes (another service sharing the
          // prefix, a truncated frame). A parse failure must not throw inside
          // the client library's message-listener callback. Parsed once per
          // delivered message, then fanned out to every local subscriber.
          let msg: BroadcastMessage;
          try {
            msg = JSON.parse(raw) as BroadcastMessage;
          } catch (err) {
            this.emit({
              category: "storage",
              type: "malformed-message-dropped",
              level: "warn",
              error: err,
              detail: { topic },
            });
            return;
          }
          // Snapshot: a subscriber unsubscribing mid-fan-out can't disturb iteration.
          for (const sub of [...entry.subscribers]) {
            if (!msg.self && msg.senderId === sub.subscriberId) continue; // exclude-self (§8), per subscriber
            sub.fn(msg);
          }
        }),
      )
        .then((u) => {
          if (entry.cancelled) u();
          else entry.unsub = u;
        })
        .catch((err) => {
          this.emit({
            category: "storage",
            type: "redis-subscribe-failed",
            level: "error",
            error: err,
            detail: { topic },
          });
        });
    }

    entry.subscribers.add(subscriber);
    return () => {
      if (!entry.subscribers.delete(subscriber)) return; // already unsubscribed — idempotent no-op
      if (entry.subscribers.size > 0) return; // other local subscribers still riding this channel
      // Last local subscriber leaving: tear down the shared redis subscription
      // (or mark it for teardown once the pending client.subscribe resolves)
      // and drop the map entry so a future subscriber issues a fresh subscribe.
      if (this.channels.get(channel) === entry) this.channels.delete(channel);
      if (entry.unsub) entry.unsub();
      else entry.cancelled = true;
    };
  }
}

/**
 * Create a redis-backed storage adapter.
 *
 * @example
 * ```ts
 * const client = wrapNodeRedis(createClient({ url }));
 * export default defineConfig({ storage: redis(client) });
 * ```
 */
export function redis(client: RedisLikeClient, opts: RedisStorageOptions = {}): StorageAdapter {
  const prefix = opts.prefix ?? "rpxd:";
  return {
    async get(key): Promise<Snapshot | undefined> {
      const raw = await client.get(`${prefix}snap:${key}`);
      return raw ? (JSON.parse(raw) as Snapshot) : undefined;
    },
    async set(key, snap) {
      await client.set(`${prefix}snap:${key}`, JSON.stringify(snap));
    },
    async delete(key) {
      await client.del(`${prefix}snap:${key}`);
    },
    bus: new RedisBus(client, prefix),
  };
}
