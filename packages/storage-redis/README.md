# @rpxd/storage-redis

Durable snapshots plus a **network** pubsub bus — the adapter for
multi-node deployments. Broadcasts crossing nodes is what kills instance
affinity (§8): any node can host any session.

```ts
import { redis } from "@rpxd/storage-redis";

export default defineConfig({ storage: redis(client) });
```

`redis()` takes a minimal client interface rather than depending on a
specific package — node-redis and ioredis both satisfy it with a thin
wrapper:

```ts
interface RedisLikeClient {
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
```

Note: most redis clients need a **separate connection** for subscribe mode
— have your wrapper's `subscribe` use a duplicated client if yours does.
