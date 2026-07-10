---
title: Running on Node
description: rpxd is Bun-first, but the whole runtime and wire protocol run unchanged on Node ≥ 24 via @rpxd/adapter-node and @rpxd/storage-sqlite/node.
sidebar:
  order: 2
---

rpxd is Bun-first, but nothing in the runtime is Bun-only past the adapter
boundary. The handler is web-standard (`Request`/`Response`/`ReadableStream`),
so `@rpxd/adapter-node` runs the same server on **Node ≥ 24** — the floor the
package's `engines` enforces and CI tests against.

## When you'd choose Node

Reach for Node when your deployment target, platform, or existing operational
story is Node-shaped — a Node-only host, a shared base image, an org that
standardizes on it. If you're greenfield, Bun is the default and the fast path.
The addressable surface is otherwise identical: same framework, same wire
protocol, same storage seam.

Node ≥ 24 is required because rpxd runs its TypeScript source directly, with no
build step and no `--experimental-transform-types` — the source is kept erasable
(no enums, parameter properties, or runtime namespaces), which unflagged Node ≥
24 executes as-is.

## The two swaps

Two things differ from the Bun runtime; everything else is untouched.

- **The adapter.** `nodeAdapter()` bridges `node:http` to the web-standard
  handler and upgrades WebSockets through the [`ws`](https://github.com/websockets/ws)
  package (Bun uses `Bun.serve` natively). You rarely name it: `rpxd start`
  selects `nodeAdapter` automatically when it detects it isn't running on Bun.
- **SQLite.** `bun:sqlite` doesn't exist on Node, so swap `sqlite()` for
  `sqliteNode()` from `@rpxd/storage-sqlite/node`, which is backed by
  `better-sqlite3` behind the identical schema and `StorageAdapter` interface.
  Add `better-sqlite3` (a peer dependency) to your app.

```ts
// rpxd.config.ts — the Node variant
import { defineConfig } from "@rpxd/cli";
import { sqliteNode } from "@rpxd/storage-sqlite/node";

export default defineConfig({
  storage: sqliteNode("./data.db"), // bun:sqlite → better-sqlite3
});
```

With that config in place, `rpxd start` under Node serves the `rpxd build`
output exactly as it does on Bun — it picks the Node adapter for you.

## Embedding in a custom `node:http` server

If you're mounting rpxd inside your own Node server rather than using
`rpxd start`, use the adapter directly. It's a thin request bridge plus WS
upgrades — the same handler either way:

```ts
import { createRpxdHandler, wsTransport } from "@rpxd/server-bun";
import { nodeAdapter } from "@rpxd/adapter-node";

const handler = createRpxdHandler({ routes: [{ path: "/", def }] });
const ws = wsTransport(handler);

const handle = nodeAdapter().serve({
  port: 3000,
  websocket: ws.websocket,
  fetch: async (req, upgrade) => (await ws.handleUpgrade(req, upgrade)) ?? handler.fetch(req),
});
await handle.ready; // node:http binds on the next tick
console.log(`live on :${handle.port}`);
```

## What's identical

The whole runtime above the adapter is shared: the fluent chain, optimistic
replay, the [wire protocol](/rpxd-live/concepts/wire-protocol/), the storage and
pubsub seams, SSR adoption, eviction. The [deployment
checklist](/rpxd-live/operations/deploying/) (`RPXD_SESSION_SECRET`, Secure
cookies, `debugErrors` off, a durable adapter) and the
[multi-node story](/rpxd-live/operations/scaling/) apply unchanged — `redis()`
works the same on either runtime.
