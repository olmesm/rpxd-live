---
name: verify
description: How to stand up and drive a real rpxd server (Bun or Node, SSE or WS) to verify runtime changes end-to-end over real sockets.
---

# Verifying rpxd server changes end-to-end

Unit suites drive `handler.fetch` directly and never touch a real socket.
Transport-level behavior (backpressure, connection teardown, WS framing) needs
a live server + raw TCP client. Recipe that works:

## Launch

Write a standalone script at the repo root importing the public surfaces by
path (workspace packages are not linked into root `node_modules`):

```ts
import { createRpxdHandler, bunAdapter, wsTransport } from "./packages/server-bun/src/index.ts";
import { nodeAdapter } from "./packages/adapter-node/src/index.ts";
```

- Bun runtime: `bun run script.ts`
- Node runtime (real `node:http`): `node --experimental-strip-types script.ts`
  (Node 22 strips the cross-package `.ts` imports fine)
- `createRpxdHandler({ cookie: { sign: false }, ... })` + a literal
  `rpxd_sid=<sid>` cookie header keeps one stable session across requests.
- Mount an instance with `POST /__rpxd/control` `{type:"mount",path}`, then
  drive rpcs with `POST /__rpxd/rpc` `{v:1,instance,rpcId,calls:[...]}` (202 =
  accepted; the ack rides the stream, not the response).

## Simulating a slow/stalled client

`net.connect` + hand-written `GET /__rpxd/stream HTTP/1.1` (or a WS upgrade
with a literal `Sec-WebSocket-Key`), then `sock.pause()` after the first
`data` event.

Gotchas learned the hard way:

- **Kernel buffers absorb ~4 MiB on loopback** before the server feels any
  backpressure. Pump tens of MiB before concluding "no backpressure".
- **Bun.serve drains response `ReadableStream`s unboundedly** (both queue mode
  and `type:"direct"`, verified on Bun 1.3) — `desiredSize` never goes
  negative on Bun SSE. Node's adapter does propagate socket backpressure.
- A server-side kill's FIN queues **behind** the stalled bytes: the paused
  client never sees `close`. `sock.resume()` after the kill and then await
  `close` to prove teardown.
- `Bun.serve.stop(true)` can hang when the stalled raw socket lives in the
  same process — wrap the script in `timeout` and treat that hang as noise.
