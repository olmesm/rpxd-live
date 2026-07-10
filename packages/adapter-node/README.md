# @rpxd/adapter-node

The Node `ServerAdapter` (§14) — the `node:http` mirror of
[`@rpxd/server-bun`](../server-bun)'s `bunAdapter`. The rpxd runtime handler is
web-standard (`Request`/`Response`/`ReadableStream`) with no Bun types past the
adapter boundary, so this is ~130 lines: a `node:http` request bridge plus WS
upgrades through the [`ws`](https://github.com/websockets/ws) package (noServer).

Requires **Node ≥ 24** (stable, unflagged TypeScript execution — the floor CI
tests against, and what `engines` enforces). The rpxd source is kept erasable
(no parameter properties, enums, or runtime namespaces) so Node runs it
directly with no build step and no `--experimental-transform-types`.

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

`rpxd start` selects this adapter automatically when not running on Bun. For
durable snapshots on Node, pair it with `sqliteNode` from
[`@rpxd/storage-sqlite/node`](../storage-sqlite) (`better-sqlite3`).
