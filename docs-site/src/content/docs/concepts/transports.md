---
title: Transports & connection lifecycle
description: SSE by default, WebSocket opt-in — API-identical. How connections reconnect, adopt SSR-warmed instances, and how instances are evicted.
sidebar:
  order: 2
---

rpxd runs its live connection over Server-Sent Events (the default) or a
WebSocket (opt-in). This page helps you choose between them, and explains what
happens to a connection over its life: status, reconnects, and eviction.

Either way the API shape is identical. The
[envelope](/rpxd-live/concepts/wire-protocol/) — the message format on the
wire — is transport-agnostic, so switching changes no app code and no
generated code. Connections are disposable; state is not.

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
protocol-version mismatch is rejected per rpc batch with an error ack — the
server's acknowledgment of the batch — not by failing the connection. See the
[wire protocol](/rpxd-live/concepts/wire-protocol/).)

### How a refusal looks on each transport

On SSE a refusal is easy to detect: the `EventSource` closes before it ever
opens, so the client stops retrying and settles on `error`. On WebSocket it's
murkier. A WS client can't observe the HTTP status of a failed upgrade — a 403
and a server mid-restart close identically before `open` — so a pre-`open`
close always backoff-retries. The one terminal WS signal is the server closing
an established socket with the `4403` policy code.

## Reconnect

Two terms first. An SSR page load embeds an **attach token**, which lets the
connection adopt the still-warm (in-memory) instance the render used. Every
envelope carries a **seq**, a per-instance counter (see
[SSR](/rpxd-live/concepts/ssr/) and the
[wire protocol](/rpxd-live/concepts/wire-protocol/)).

The SSE stream URL — including that attach token and its `seq` — is fixed when
the connection opens. `EventSource` auto-reconnects by re-requesting the same
URL. The server never tries to compute what a reconnecting client missed. An
attach adopts the warm instance only when the exact token+seq still match on
the connection's first subscribe, which happens exactly once, at the SSR
handoff. Every other subscribe — including every reconnect — gets an
unconditional `full` snapshot. Unacked optimistic rpcs are resent with their
client-generated ids and the server dedupes. This path is identical on either
transport; WS reconnects resync the same way, without the stale attach token.

## Eviction

When an instance's subscriber count reaches 0, it enters a warm TTL — a grace
period of 60s by default, configurable per-app via `instances.warmTtlMs`. If
nothing reconnects before the TTL elapses, the instance is snapshotted to
storage and dropped from memory. A later request **cold-wakes** it by
re-running `mount` — see
[snapshots are continuity, not cache](/rpxd-live/concepts/persistence/#snapshots-are-continuity-not-cache)
for why. The registry also caps how
many instances it holds at all, independent of the TTL — see
[Capacity caps as DoS hardening](/rpxd-live/operations/security/#capacity-caps-as-dos-hardening).

## Disconnect mid-handler

A dropped connection does **not** abort a running handler. The drop only
unsubscribes the stream and re-arms the warm-TTL evict timer. The handler runs
to completion and its ack is produced and **cached**. `ctx.signal` aborts
later: at dispose/eviction after the warm TTL, on an explicit `ctx.abort`, or
on a superseding URL change — never on the disconnect itself. On reconnect the
client resends the unacked batch and the dedupe window returns the cached ack
without re-running it.
