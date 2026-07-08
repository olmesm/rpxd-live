---
title: Transports & connection lifecycle
description: SSE by default, WebSocket opt-in — API-identical. How connections reconnect, adopt SSR-warmed instances, and how instances are evicted.
sidebar:
  order: 2
---

Connections are disposable; state is not. The same live object runs over
Server-Sent Events (default) or WebSocket (opt-in), and the API shape is
identical — the [envelope is transport-agnostic](/rpxd-live/concepts/wire-protocol/),
so there's no codegen impact from switching.

## SSE (default)

- **Server → client**: SSE — a one-way patch stream. `EventSource`
  auto-reconnects and it's proxy-friendly.
- **Client → server**: HTTP POST, batched per tick.

## WebSocket (opt-in)

Set `transport: ws()` in `rpxd.config.ts` (or `rpxd dev --transport ws`). A
single duplex connection carries everything, with lower per-rpc overhead. The
API shape is unchanged.

```ts
// rpxd.config.ts
import { ws } from "@rpxd/server-bun";
export default defineConfig({ transport: ws() });
```

## Status

The client exposes a connection status:

```
connecting → live → reconnecting → error
```

`error` is terminal, and only reached on protocol-version mismatch or auth
rejection.

## Reconnect

On reconnect the client re-attaches with its last seen `seq`; the server
compares and pushes a `full` snapshot if the client is behind. Unacked
optimistic rpcs are resent with their client-generated ids and the server
dedupes. This path is identical on either transport.

## Eviction

When an instance's subscriber count reaches 0, it enters a warm TTL (~60s). If
nothing reconnects, the instance is snapshotted to storage and dropped from
memory. A later request **cold-wakes** it by re-running `mount` — snapshots are
session continuity, not a cache (see
[Persistence](/rpxd-live/concepts/persistence/)).

## Disconnect mid-handler

If a connection drops while a handler is running, the runtime aborts
`ctx.signal`; the handler winds down cooperatively (its `finally` blocks run)
and no ack is sent. The client resends on reconnect and the dedupe window
decides whether it re-runs.
