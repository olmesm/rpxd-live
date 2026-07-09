# @rpxd/server-bun

The HTTP/WS runtime handler and the `ServerAdapter` seam — the piece that
turns live objects into a served app on Bun.

`rpxd dev`/`rpxd start` (from [`@rpxd/cli`](../cli)) use this internally;
import it directly to embed rpxd in your own Bun server.

## What lives here

- **`createRpxdHandler`** — web-standard `Request` → `Response` handler for
  the whole wire: `GET /__rpxd/stream` (SSE envelopes), `POST /__rpxd/rpc`
  (batches), `POST /__rpxd/control` (mount / resync / url / release), plus SSR
  with attach tokens so the page adopts its server-warmed instance. Owns
  sessions (cookie), instance registry, warm-TTL eviction, and rpc dedupe.
  Plain HTTP routes (`httpRoutes`, from `route()`) are matched before the
  SSR/`404` fallthrough — that's how webhooks and `/api/auth/*` are served.
- **`bunAdapter`** — the `ServerAdapter` implementation over `Bun.serve`.
  The handler itself has no Bun types past this boundary, which is what
  keeps a future Node adapter small.
- **`wsTransport`** — the optional single-duplex-socket transport (§11):
  same envelopes, different framing.

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
[`docs/protocol.md`](../../docs/protocol.md).
