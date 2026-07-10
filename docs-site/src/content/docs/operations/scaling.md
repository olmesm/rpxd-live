---
title: Scaling & multi-node
description: No sticky sessions — any node can host any session. What multi-node needs (Redis for snapshots and the bus), the RedisLikeClient wiring, and the in-process-throttle caveat.
sidebar:
  order: 3
---

## Any node can host any session

Most stateful realtime frameworks pin a session to the node that holds its
object, so scaling out means sticky sessions and a routing layer that keeps a
client glued to "its" node. rpxd doesn't. Instances are **per-session**, they
coordinate through a [broadcast bus](/rpxd-live/concepts/pubsub/) rather than
shared memory, and their [snapshots](/rpxd-live/concepts/persistence/) live in
shared storage — so there is no affinity to maintain. A round-robin or
least-connections load balancer just works: any request can land on any node,
which cold-wakes the session from storage if it isn't already warm there.

This is a genuine operational advantage, not a caveat with a workaround. You
scale horizontally by adding nodes behind a plain LB.

## The one requirement: Redis

The property above holds *only* when both halves of the storage seam span your
nodes. `redis()` is the adapter that makes them:

- **Snapshots** in Redis → any node can cold-wake any session.
- **The pubsub bus** over Redis pub/sub → a broadcast on one node reaches
  subscribers on every other.

`memory()` and `sqlite()` both use an in-process `LocalBus` and node-local
storage — perfectly good for a single node, but they confine you to one. With
them, a second node can neither see the first node's sessions nor receive its
broadcasts. **Multi-node means `redis()`.**

## Wiring Redis

`redis()` takes a minimal client interface — `RedisLikeClient` — rather than
depending on a specific package, so node-redis and ioredis both satisfy it with
a thin wrapper. The shape it needs:

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

Redis puts a connection into subscriber mode exclusively, so your wrapper's
`subscribe` should use a **separate (duplicated) connection** from the one doing
`get`/`set`/`publish`.

```ts
// node-redis (v4+): a base client, plus a duplicate for subscriptions.
import { createClient } from "redis";
import { redis, type RedisLikeClient } from "@rpxd/storage-redis";

const base = createClient({ url: process.env.REDIS_URL });
await base.connect();

const client: RedisLikeClient = {
  get: (k) => base.get(k),
  set: (k, v) => base.set(k, v),
  del: (k) => base.del(k),
  publish: (ch, m) => base.publish(ch, m),
  subscribe: async (ch, onMessage) => {
    const sub = base.duplicate();
    await sub.connect();
    await sub.subscribe(ch, onMessage);
    return () => sub.unsubscribe(ch).then(() => sub.quit());
  },
};

export default defineConfig({ storage: redis(client) });
```

```ts
// ioredis: a separate Redis instance for subscriber mode.
import Redis from "ioredis";

const base = new Redis(process.env.REDIS_URL);

const client: RedisLikeClient = {
  get: (k) => base.get(k),
  set: (k, v) => base.set(k, v),
  del: (k) => base.del(k),
  publish: (ch, m) => base.publish(ch, m),
  subscribe: (ch, onMessage) => {
    const sub = new Redis(process.env.REDIS_URL);
    sub.subscribe(ch);
    sub.on("message", (channel, message) => channel === ch && onMessage(message));
    return () => void sub.disconnect();
  },
};
```

**`prefix`** namespaces every key and channel (default `rpxd:`) — set it to
share one Redis instance with other apps or environments:

```ts
redis(client, { prefix: "myapp:prod:" });
```

### Delivery is best-effort — your database is the truth

A publish that fails is **logged, not thrown** (an uncaught rejection would
crash Node under its default policy). The practical consequence: a dropped
broadcast costs its peers one *live* update — the event never reaches their warm
instances. It is not healed by a `resync`, which returns the current in-memory
state (still missing the event); it's healed the next time those instances
**re-mount** — a cold wake, a navigation, or a full reload re-runs `setup`/`load`,
which read fresh truth from your database. Broadcasts are the real-time layer;
the database is the source of truth. Design `on` handlers as event application
over data you can also re-derive from a load, and a missed broadcast degrades to
"a moment stale until the next load," never to permanent divergence.

## What stays per-node

One thing does *not* span nodes: the opt-in request **throttle** is an
in-process token bucket. In a multi-node deployment each node meters its own
share, so N nodes multiply the effective limit by N. **Rate-limit at the proxy
or edge** for a global ceiling. (And note the throttle key must derive from a
trusted source — a raw `X-Forwarded-For` is client-spoofable, so an attacker
rotating it gets a fresh bucket per request; key on a socket peer address or a
proxy-set header you control.)

## Rolling deploys

Because connections are long-lived, a rollout drops every open SSE/WS stream on
a replaced node. That's a non-event for correctness: clients auto-reconnect to a
surviving (or new) node and `resync`, and unacked optimistic rpcs are resent
with their client ids and deduped server-side. To smooth it, drain connections —
stop routing new traffic to a node, give open streams a grace period, then stop
it — so clients reconnect in a trickle rather than a thundering herd. See the
[reconnect semantics](/rpxd-live/concepts/transports/#reconnect) for exactly what
the client does on a dropped connection.
