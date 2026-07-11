# @rpxd/adapter-node

Run an rpxd app on Node.js (Node ≥ 24).

```sh
bun add @rpxd/adapter-node
```

Not yet on npm — work from a clone of the repo for now.

`rpxd start` picks this adapter automatically when it isn't running on Bun, so
most apps never import it directly. Import it yourself to embed rpxd in your
own `node:http` server.

The rpxd runtime handler is web-standard (`Request`/`Response`/
`ReadableStream`) with no Bun types, so this adapter is just a small
`node:http` request bridge plus WebSocket upgrades through the
[`ws`](https://github.com/websockets/ws) package. Node 24+ runs the TypeScript
source directly — no build step needed.

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

For durable snapshots on Node, pair it with `sqliteNode` from
[`@rpxd/storage-sqlite/node`](../storage-sqlite) (built on `better-sqlite3`).

Docs: https://olmesm.github.io/rpxd-live/operations/node/
