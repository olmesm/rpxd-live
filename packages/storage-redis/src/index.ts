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
import type { BroadcastMessage, PubSubBus, Snapshot, StorageAdapter } from "@rpxd/core";

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

class RedisBus implements PubSubBus {
  // Plain fields (not parameter properties) so the source stays erasable —
  // Node runs it under default, unflagged TypeScript stripping.
  private readonly client: RedisLikeClient;
  private readonly prefix: string;
  constructor(client: RedisLikeClient, prefix: string) {
    this.client = client;
    this.prefix = prefix;
  }

  publish(msg: BroadcastMessage): void {
    // Surface (rather than drop) a publish failure: a bare `void` on a
    // rejecting promise is an unhandled rejection, which crashes Node under the
    // default --unhandled-rejections=throw.
    Promise.resolve(
      this.client.publish(`${this.prefix}bus:${msg.topic}`, JSON.stringify(msg)),
    ).catch((err) => {
      console.error(`[rpxd] redis publish to "${msg.topic}" failed:`, err);
    });
  }

  subscribe(topic: string, subscriberId: string, fn: (msg: BroadcastMessage) => void): () => void {
    let unsub: (() => void) | undefined;
    let cancelled = false;
    // Like publish above: a rejecting subscribe (redis unreachable at instance
    // mount) must be caught, not left as an unhandled rejection. `unsub` stays
    // undefined, so the returned unsubscribe remains a safe no-op.
    Promise.resolve(
      this.client.subscribe(`${this.prefix}bus:${topic}`, (raw) => {
        // The channel carries untrusted bytes (another service sharing the
        // prefix, a truncated frame). A parse failure must not throw inside the
        // client library's message-listener callback.
        let msg: BroadcastMessage;
        try {
          msg = JSON.parse(raw) as BroadcastMessage;
        } catch (err) {
          console.error(`[rpxd] redis: dropped malformed message on "${topic}":`, err);
          return;
        }
        if (!msg.self && msg.senderId === subscriberId) return; // exclude-self (§8)
        fn(msg);
      }),
    )
      .then((u) => {
        if (cancelled) u();
        else unsub = u;
      })
      .catch((err) => {
        console.error(`[rpxd] redis subscribe to "${topic}" failed:`, err);
      });
    return () => {
      cancelled = true;
      unsub?.();
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
