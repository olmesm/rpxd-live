# @rpxd/storage-redis

Durable snapshots in Redis plus a network pubsub bus — the adapter for
multi-node deployments. Broadcasts cross nodes, so any node can host any
session.

```sh
bun add @rpxd/storage-redis
```

Not yet on npm — work from a clone of the repo for now.

```ts
import { redis } from "@rpxd/storage-redis";

export default defineConfig({ storage: redis(client) });
```

`redis()` takes a minimal client interface rather than depending on a
specific package. node-redis and ioredis both satisfy it with a thin
wrapper — [Scaling](https://olmesm.github.io/rpxd-live/operations/scaling/)
has ready-made wrappers for both.

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

Note: most Redis clients need a **separate connection** for subscribe mode.
If yours does, have your wrapper's `subscribe` use a duplicated client.

Docs: https://olmesm.github.io/rpxd-live/
