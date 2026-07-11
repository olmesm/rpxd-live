---
"@rpxd/server-bun": minor
"@rpxd/adapter-node": minor
"@rpxd/cli": minor
---

Per-connection egress byte budget (`maxBufferedBytes`, default 8 MiB, `null`
disables): a connection buffering more unsent bytes than the budget is killed
with a `security`/`stream-overflow` diagnostic, and the client's reconnect
recovers via the resync snapshot. Enforced continuously on WS (both runtimes)
and Node-adapter SSE; on Bun SSE it catches burst overflows only (Bun buffers
streamed responses internally). The Node adapter also now destroys a response
whose body stream errors while parked on backpressure, so killed connections
are reaped instead of leaked. Configurable via the config `instances` block.
