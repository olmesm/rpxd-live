---
title: Wire protocol
description: The transport-agnostic envelope, the upstream rpc batch, control messages, and the invariants both core and client implement exactly.
sidebar:
  order: 1
---

The protocol is **one page and transport-agnostic**. `@rpxd/core` (server) and
`@rpxd/client` both implement exactly this and nothing more.

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
  /** Instance the envelope belongs to. */
  instance: string;
  /** Immer patches to apply to confirmed state. Mutually exclusive with `full`. */
  patches?: Patch[];
  /** Full snapshot (recovery / initial attach). Mutually exclusive with `patches`. */
  full?: unknown;
  /** Present when this envelope acks an rpc batch: the client-generated batch id. */
  rpcId?: string;
  /** tempId → realId links resolved from server-side patch positions. */
  idMap?: Record<string, string>;
  /** Present when the acked rpc batch failed. */
  error?: { name: string; message: string; rpc?: string };
};

type Patch = {
  op: "replace" | "add" | "remove" | "append";
  path: (string | number)[];
  value?: unknown;
};
// `append`: concatenate `value` (string) onto the string at `path` — emitted
// when a flush grows a string by a suffix (token streams), so the wire carries
// only the delta. Applying `append` to a non-string is a protocol error.
```

Rules:

- `seq` increases by exactly 1 per envelope per instance; the client applies
  envelopes in order.
- **Gap detected** (`seq > last + 1`) → the client sends `resync` and ignores
  further patch envelopes until a `full` arrives.
- `full` replaces confirmed state wholesale and resets `last` to its `seq`.
- Session-slice patches ride the same stream with paths prefixed
  `["$session", ...]`.
- One rpc **batch** produces exactly one ack envelope. Broadcast-driven
  envelopes carry no `rpcId`.
- `error` and `patches` may coexist (a failed rpc whose `onError` produced
  repairs, or same-tick writes committing alongside the error ack).

## Upstream: the rpc batch

```ts
type RpcBatch = {
  v: 1; // PROTOCOL_VERSION
  instance: string;
  rpcId: string; // client-generated (uuid); server dedupes on it
  calls: { rpc: string; payload: unknown; tempIds?: string[] }[];
};
```

- The client coalesces same-tick calls (a `queueMicrotask` flush) into one batch
  → one ack.
- **At-least-once delivery**: unacked batches are resent after reconnect with
  the same `rpcId`; the server keeps a short per-session dedupe window and
  re-acks duplicates without re-running them.
- Streaming rpcs push mid-handler flushes as ordinary non-ack envelopes; the ack
  (with `rpcId`) rides the final flush.

## Control messages (upstream)

```ts
type Control =
  | { v: 1; type: "attach"; instance: string; token: string; seq: number }
  | { v: 1; type: "resync"; instance: string; seq: number }
  | { v: 1; type: "mount"; path: string; search: Record<string, string> }
  | { v: 1; type: "params"; instance: string; search: Record<string, string> };
```

- `attach` within the pending-attach TTL (~10s) adopts the SSR-warmed instance
  and resumes from `seq`. Expired/unknown token → the server silently re-mounts
  and pushes `full`.
- `resync` → the server pushes `full` with the current `seq`. Also the reconnect
  path.

## Framing

**SSE.** Endpoint `GET /__rpxd/stream` (one per connection, all instances
multiplexed). Each envelope is one SSE event (`event: env`, `data: <json>`, `id:`
mirrors `seq`). Upstream: `POST /__rpxd/rpc` (batch) and `POST /__rpxd/control`.

**WS.** A single duplex socket at `GET /__rpxd/ws` (upgrade). Every message is
one JSON object — envelopes downstream, batches/controls upstream. Same
envelope, same seq rules, same recovery.

## Invariants

1. Applying `patches` in seq order over the last `full` always equals server
   confirmed state.
2. Every batch gets exactly one ack — success or `error` — unless the connection
   dies; then resend + dedupe makes delivery effectively once.
3. A client that only understands `full` (ignores all patches, resyncs every
   gap) still converges.
4. Envelopes for one instance never interleave out of seq order, regardless of
   transport.
