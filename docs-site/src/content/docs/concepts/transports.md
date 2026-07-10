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
import { ws } from "@rpxd/cli";
export default defineConfig({ transport: ws() });
```

(`ws()` is the config helper from `@rpxd/cli`; `@rpxd/server-bun` exports the
runtime `wsTransport` the server wires it to.)

## Status

The client exposes a connection status:

```
connecting → live → reconnecting → error
```

`error` is terminal and reached only when the server **refuses** the connection
— an auth or origin rejection at connect. A connection that opened and later
dropped cycles `live → reconnecting → live`; it never becomes `error`. (A
protocol-version mismatch is rejected per rpc batch with an error ack, not by
failing the connection — see the
[wire protocol](/rpxd-live/concepts/wire-protocol/).)

On SSE a refusal shows up as the `EventSource` closing before it ever opens —
the client stops retrying and settles on `error`. A WS client can't observe the
HTTP status of a failed upgrade (a 403 and a server mid-restart close
identically before `open`), so on WS a pre-`open` close always backoff-retries;
the one terminal WS signal is a server closing an established socket with the
`4403` policy code.

## Reconnect

The SSE stream URL — including the SSR attach token and its `seq` — is fixed
when the connection opens; `EventSource` auto-reconnects by re-requesting that
same URL. The server does **no behind-comparison**: an attach adopts the warm
instance only when the exact token+seq still match on the first subscribe (it
does once, at SSR handoff), and every other subscribe — including every
reconnect — gets an unconditional `full` snapshot. Unacked optimistic rpcs are
resent with their client-generated ids and the server dedupes. This path is
identical on either transport (WS reconnects resync the same way, without the
stale attach token).

## Eviction

When an instance's subscriber count reaches 0, it enters a warm TTL — 60s by
default, configurable per-app via `instances.warmTtlMs`. If nothing
reconnects before the TTL elapses, the instance is snapshotted to storage and
dropped from memory. A later request **cold-wakes** it by re-running `mount`
— snapshots are session continuity, not a cache (see
[Persistence](/rpxd-live/concepts/persistence/)). The registry also caps how
many instances it holds at all, independent of the TTL — see
[Capacity caps as DoS hardening](/rpxd-live/operations/security/#capacity-caps-as-dos-hardening).

## Disconnect mid-handler

A dropped connection does **not** abort a running handler. The drop only
unsubscribes the stream and re-arms the warm-TTL evict timer; the handler runs
to completion and its ack is produced and **cached**. `ctx.signal` aborts later
— at dispose/eviction after the warm TTL (or on an explicit `ctx.abort` / a
superseding URL change), not on the disconnect. On reconnect the client resends
the unacked batch and the dedupe window returns the cached ack without
re-running it.
