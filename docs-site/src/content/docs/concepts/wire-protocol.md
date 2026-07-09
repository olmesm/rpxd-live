---
title: Wire protocol
description: The transport-agnostic envelope, the upstream rpc batch, control messages, the connection lifecycle, and the invariants both core and client implement exactly.
sidebar:
  order: 1
---

One page. Transport-agnostic. This document is normative for `@rpxd/core`
(server) and `@rpxd/client`; both implement exactly this and nothing more. Spec
references: §2, §6, §11.

## Model

A **connection** carries one session's live-object instances. The server pushes
**envelopes** downstream (SSE default, WebSocket opt-in); the client sends **rpc
batches** upstream (HTTP POST, or the same WS when enabled). Envelopes are JSON.
The protocol is identical on either transport — only framing differs (SSE
`data:` lines vs WS messages).

`PROTOCOL_VERSION = 1`. The client sends it on connect; a mismatch → the server
responds with a fatal `error` envelope and closes.

## Downstream: the envelope

```ts
type Envelope = {
  /** Per-instance, monotonically increasing, starts at the snapshot's seq. */
  seq: number;
  /** Instance the envelope belongs to (route instance id for the session). */
  instance: string;
  /** Immer patches to apply to confirmed state. Mutually exclusive with `full`. */
  patches?: Patch[];
  /** Full snapshot (recovery / initial attach). Mutually exclusive with `patches`. */
  full?: unknown;
  /** Present when this envelope acks an rpc batch: the client-generated batch id. */
  rpcId?: string;
  /** tempId → realId links resolved from server-side patch positions (spec §4). */
  idMap?: Record<string, string>;
  /** Present when the acked rpc batch failed; confirmed state is unchanged beyond `patches`. */
  error?: { name: string; message: string; rpc?: string };
};

type Patch = {
  op: "replace" | "add" | "remove" | "append";
  path: (string | number)[];
  value?: unknown;
};
// `append`: concatenate `value` (string) onto the string at `path`.
// Emitted when a flush grows a string by a suffix (token streams) — the
// wire carries only the delta. Applying `append` to a non-string is a
// protocol error → client resyncs.
```

Rules:

- `seq` increases by exactly 1 per envelope per instance. The client applies
  envelopes in order.
- **Gap detected** (`seq > last + 1`) → the client discards nothing, sends
  `resync` (below), and ignores further patch envelopes until a `full` arrives.
- `full` replaces confirmed state wholesale and resets `last` to its `seq`.
- Session-slice patches ride the same stream with paths prefixed
  `["$session", ...]`; they patch the session slice, not page state.
- One rpc **batch** (see upstream) produces exactly one ack envelope: combined
  patches from all rpcs in the batch, one `rpcId`. Broadcast-driven envelopes
  carry no `rpcId`.
- `error` and `patches` may coexist: a failed rpc whose `onError` mutator
  produced repairs, or pending same-tick `patchState` writes committing
  alongside the error ack.

## Upstream: the rpc batch

```ts
type RpcBatch = {
  v: 1;                       // PROTOCOL_VERSION
  instance: string;
  rpcId: string;              // client-generated (uuid); server dedupes on it
  calls: { rpc: string; payload: unknown; tempIds?: string[] }[];
};
```

- The client coalesces same-tick calls (`queueMicrotask` flush) into one batch →
  one ack.
- **At-least-once delivery**: unacked batches are resent after reconnect with the
  same `rpcId`; the server keeps a short per-session dedupe window and re-acks
  (without re-running) duplicates.
- Streaming rpcs push their mid-handler `patchState` flushes as ordinary non-ack
  envelopes; the ack (with `rpcId`) rides the final flush at handler completion
  (or `error` on throw). `sync.pending` spans call → ack.

## Control messages (upstream)

```ts
type Control =
  | { v: 1; type: "attach"; instance: string; token: string; seq: number }      // SSR adoption (§12)
  | { v: 1; type: "resync"; instance: string; seq: number }                     // gap recovery
  | { v: 1; type: "mount"; path: string; search: Record<string, string>; stream?: string } // cold / tier-2 mount
  | { v: 1; type: "url"; instance: string; search: Record<string, string> }     // nav.patch → guard + load
  | { v: 1; type: "release"; instance: string; stream: string };                // tier-2 abandons an instance
```

- `attach` within the pending-attach TTL (~10s) adopts the SSR-warmed instance
  and resumes the stream from `seq`. Expired/unknown token → the server silently
  re-mounts and pushes `full`.
- `resync` → the server pushes `full` with the current `seq`. Also the reconnect
  path: `EventSource` reconnects, the client re-attaches with its last seen
  `seq`, the server compares and pushes `full` if behind.
- `url` reconciles the instance to a new URL — `guard` then `load` (§7); a deny
  comes back as `{ redirect }` (SSE control response) or a `redirect` envelope (WS).
- `mount`'s optional `stream` id and `release` drive a **tier-2 soft reload**: a
  same-route path change joins a fresh instance to the open stream and releases
  the old one, so the transport survives.

## Connection lifecycle (§11)

- Client status: `connecting → live → reconnecting → error` (terminal `error`
  only on protocol version mismatch or auth rejection).
- Authentication happens once at connect (cookie/token via config hook); every
  reducer sees the resulting `ctx.session`.
- The server evicts an instance when subscribers reach 0, after a warm TTL
  (~60s): snapshot to storage, drop from memory. Cold wake re-runs `mount`
  (snapshots are session continuity, not cache — spec §9).
- Disconnect mid-handler → the runtime aborts `ctx.signal`; the handler winds
  down cooperatively (`finally` blocks run); no ack is sent (the client resends
  on reconnect; the dedupe window decides).

## SSE framing

- Endpoint: `GET /__rpxd/stream` (one per connection, all instances
  multiplexed).
- Each envelope is one SSE event: `event: env`, `data: <json>`, SSE `id:`
  mirrors `seq` for proxy-level resume hints (authoritative resume is still
  `resync`).
- Upstream on SSE mode: `POST /__rpxd/rpc` (batch) and `POST /__rpxd/control`.

## WS framing

- Single duplex socket, endpoint `GET /__rpxd/ws` (upgrade). Every message is one
  JSON object: envelopes downstream, batches/controls upstream. No other
  differences — same envelope, same seq rules, same recovery.

## Invariants (test these)

1. Applying `patches` in seq order over the last `full` always equals server
   confirmed state.
2. Every batch gets exactly one ack (`rpcId`) — success or `error` — unless the
   connection dies; then resend + dedupe makes delivery effectively once.
3. A client that only understands `full` (ignores all patches, resyncs every
   gap) still converges.
4. Envelopes for one instance never interleave out of seq order, regardless of
   transport.
