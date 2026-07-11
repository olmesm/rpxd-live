# @rpxd/server-bun

Serve an rpxd app with Bun: the HTTP/WebSocket handler that turns live
objects into a running server.

```sh
bun add @rpxd/server-bun
```

Not yet on npm — work from a clone of the repo for now.

`rpxd dev`/`rpxd start` (from [`@rpxd/cli`](../cli)) use this internally;
import it directly to embed rpxd in your own Bun server.

## What lives here

- **`createRpxdHandler`** — a web-standard `Request` → `Response` handler
  for the whole wire protocol. It serves `GET /__rpxd/stream` (the SSE
  update stream), `POST /__rpxd/rpc` (rpc batches), and `POST /__rpxd/control`
  (mount / resync / url / release). It also does SSR: the page gets an attach
  token so it adopts the instance the server just rendered with. Sessions
  (cookie), the instance registry, idle-instance eviction, and rpc dedupe
  live here too. Plain HTTP routes (`httpRoutes`, from `route()`) are matched
  before the SSR/404 fallthrough — that's how webhooks and `/api/auth/*` are
  served.
- **`bunAdapter`** — the `ServerAdapter` implementation over `Bun.serve`.
  The handler itself uses no Bun types past this boundary, which is what
  keeps other adapters (like [`@rpxd/adapter-node`](../adapter-node)) small.
- **`wsTransport`** — an optional transport that runs everything over one
  duplex WebSocket instead of SSE + POST. Same messages, different framing.

## Usage

```ts
import { bunAdapter, createRpxdHandler, wsTransport } from "@rpxd/server-bun";

const handler = createRpxdHandler({ routes, storage, render });
const ws = wsTransport(handler);

bunAdapter().serve({
  port: 3000,
  websocket: ws.websocket,
  fetch: async (req, upgrade) =>
    (await ws.handleUpgrade(req, upgrade)) ?? handler.fetch(req),
});
```

Connection lifecycle, eviction, and recovery semantics are specified in
the [Wire protocol](https://olmesm.github.io/rpxd-live/concepts/wire-protocol/).
