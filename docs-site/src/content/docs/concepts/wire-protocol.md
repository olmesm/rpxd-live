---
title: Wire protocol
description: The transport-agnostic envelope, the upstream rpc batch, control messages, the connection lifecycle, and the invariants both core and client implement exactly.
sidebar:
  order: 7
---

You don't need this page to use rpxd — it's the contract for implementers and
the curious. One page, transport-agnostic, and normative for `@rpxd/core`
(server) and `@rpxd/client`: both implement exactly this and nothing more.
Section references (§) point into
[the spec](https://github.com/olmesm/rpxd-live/blob/main/spec.md); this page
covers spec §2, §6, and §11.

## Model

A **connection** carries one session's live-object instances. The server pushes
**envelopes** downstream (SSE default, WebSocket opt-in); the client sends **rpc
batches** upstream (HTTP POST, or the same WS when enabled). Envelopes are JSON.
The protocol is identical on either transport — only framing differs (SSE
`data:` lines vs WS messages).

`PROTOCOL_VERSION = 1`. There is **no connect-time handshake**: the version
rides every rpc batch (`RpcBatch.v`, below). A batch whose `v` doesn't match
the server is rejected with an error ack — `error: { name: "ProtocolError" }`
on the batch's `rpcId`. No handler runs; confirmed state is untouched. The
version is bumped only on a breaking change to the envelope shape.

## Downstream: the envelope

```ts
type Envelope = {
  /** Per-instance, monotonically increasing, starts at the snapshot's seq. */
  seq: number;
  /** Instance the envelope belongs to (route instance id for the session). */
  instance: string;
  /** Immer patches to apply to confirmed state. Mutually exclusive with `full`. */
  patches?: Patch[];
  /** Full snapshot `{ state, session }` (recovery / initial attach). Mutually exclusive with `patches`. */
  full?: { state: unknown; session: unknown };
  /** Present when this envelope acks an rpc batch: the client-generated batch id. */
  rpcId?: string;
  /** tempId → realId links the handler declared via `ctx.resolveId` (spec §4). */
  idMap?: Record<string, string>;
  /** Present when the acked rpc batch failed; confirmed state is unchanged beyond `patches`. */
  error?: { name: string; message: string; rpc?: string };
  /** Runtime redirect target (§10): a `guard`/`load` deny during a URL change — the client soft-navigates. */
  redirect?: string;
  /** WS only: echo of the mount frame's `mountId`, correlating the outcome of a socket mount that never bound an instance. */
  mountId?: string;
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
- **`idMap` is server-declared, not position-matched.** It carries only the
  links a handler explicitly published with `ctx.resolveId(tempId, realId)`
  (spec §4). The client's position-matching of optimistic tempIds against
  confirmed patches is a *client-side* fallback and never rides the wire.
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
  v: 1;                       // PROTOCOL_VERSION — checked per batch
  instance: string;
  rpcId: string;              // client-unique `c${counter}`; server dedupes on it
  calls: { rpc: string; payload: unknown }[];
};
```

- The client coalesces same-tick calls (`queueMicrotask` flush) into one batch →
  one ack. `rpcId` is a client-local counter (`c1`, `c2`, …), unique within a
  connection — not a uuid; the server only needs it to dedupe resends.
- tempIds are **client-local**: the store hands them to optimistic reducers and
  reconciles them on ack. They do not travel in the batch — the server learns of
  a tempId only if a handler calls `ctx.resolveId` (which comes back as `idMap`).
- **At-least-once delivery**: unacked batches are resent after reconnect with the
  same `rpcId`; the server keeps a short per-session dedupe window and re-acks
  (without re-running) duplicates.
- Streaming rpcs push their mid-handler `patchState` flushes as ordinary non-ack
  envelopes; the ack (with `rpcId`) rides the final flush at handler completion
  (or `error` on throw). `sync.pending` spans call → ack.
- A batch carrying more than `maxBatchCalls` calls (default 256) is rejected
  wholesale — no call runs — with a `PayloadTooLargeError` ack. See
  [Ingress limits](#ingress-limits).
- A batch naming an **unknown or unowned instance** — a stale id after eviction
  or a redeploy — is error-acked with `error: { name: "UnknownInstanceError" }`
  at `seq: 0`, delivered over the session's stream/socket. The pending call
  therefore rejects instead of hanging. No handler runs; every batch still gets
  exactly one ack.

## Ingress limits

The runtime caps attacker-controllable ingress so a single request can't
exhaust server memory/CPU (a §11 requirement). Both caps are enforced in the
shared request handler, so the Bun and Node adapters behave identically, and
both are configurable on `createRpxdHandler`:

- **`maxBodyBytes`** (default 1 MiB) — the max byte length of an rpc/control
  request body or WS frame. Over HTTP an oversized body is rejected with `413`
  before it's parsed (`Content-Length` is a fast-path hint; the streamed read is
  the real guard). Over WS the oversized frame is dropped before `JSON.parse`.
- **`maxBatchCalls`** (default 256) — the max calls in one rpc batch. An over-cap
  batch is error-acked (`rpcId` preserved) without running any call.

Both defaults sit far above any realistic client (batches are single-digit
same-tick coalescing; rpc payloads are reducer inputs), so no ordinary app hits
them. Raise either per-app if a workload legitimately needs to.

## Control messages (upstream)

Control messages reconcile the connection to navigation and gap recovery. None
carry `v` — the version check is a batch concern. SSR adoption is **not** a
control message: it rides the stream/socket URL as `?attach=<token>&seq=<n>`
query params (below).

```ts
type Control =
  | { type: "resync"; instance: string }                                        // gap recovery / late attach
  | { type: "mount"; path: string; props: Record<string, unknown>; stream?: string; mountId?: string } // cold / same-route / slot mount
  | { type: "url"; instance: string; props: Record<string, unknown> }           // nav.patch → guard + load
  | { type: "release"; instance: string; stream: string };                      // same-route nav abandons an instance
```

- **SSR adoption (§12)** happens at connect: the stream/WS URL carries
  `?attach=<token>&seq=<n>`. On the connection's first subscribe, a token that
  matches a warm instance whose `seq` equals the client's adopts it and resumes
  from that seq — no snapshot. Any mismatch (expired/unknown token, or a seq that
  has moved on) falls through to an unconditional `full`.
- `resync` → the server pushes a `full` at the current `seq`. It carries no seq
  and requests no comparison: the server always answers with a full snapshot.
- `mount` matches `path` against the **union** of routed pages and mount-only
  slots (ADR 0002 item 6) and returns `{ instance, seq, path, params }` (or
  `{ redirect }` on a `setup`/`guard` deny). Its `props` payload is a JSON value
  model (values arrive already typed, not as raw query strings) validated against
  the matched registration's props schema **before** `guard` — an invalid record
  is a `422` (SSE control response) or an `error` envelope (WS) and nothing is
  built. Its optional `stream` id and the `release` message drive a **soft
  reload**: a same-route path change joins a fresh instance to the open stream
  and releases the old one, so the transport survives. Mounting a routed page's
  own pattern **shares** the session's existing instance for that pattern (the
  two-tabs semantics) rather than building a second one. A pattern registered as
  a mount-only slot is **not** served over a browser GET — that is a `404`.
- Over WS, `mount` has no response slot — the outcome arrives as envelopes on
  the socket. A mount that denies or fails before binding an instance answers
  with `instance: ""`, which the client's bound-instance filter can never
  match. The frame's optional `mountId` closes that gap: the server echoes it
  on the resulting `redirect`/`error` envelope, and the client correlates the
  outcome to its in-flight mount by id.
- `url` reconciles the instance to a new URL — `guard` then `load` (§7); a deny
  comes back as `{ redirect }` (SSE control response) or a `redirect` envelope (WS).
  Its `props` payload is a JSON value model (like `mount`, values arrive already
  typed, not as raw query strings) validated against the instance's registration
  props schema **before** `guard`+`load` (ADR 0002 item 7) — an invalid record is
  a `422` (SSE control response) or an `error` envelope (WS) and no reconcile
  runs. Unlike a denied `mount`, the instance addressed by `url` is already bound,
  so the WS `error`/`redirect` envelope carries that instance's id (no `mountId`).

## Connection lifecycle (§11)

- Client status: `connecting → live → reconnecting → error`. `error` is
  **terminal** and reached only when the server *refuses* the connection — an
  auth or origin rejection at connect. A dropped-then-restored connection cycles
  `live → reconnecting → live` and never becomes `error`. (A protocol-version
  mismatch is a per-batch error ack, not a connection-fatal state.)
- Authentication happens once at connect (cookie/token via config hook); every
  reducer sees the resulting `ctx.session`. A refusal (403) is terminal on SSE:
  the `EventSource` closes before any `open` (→ `error`, no retry). A WS client
  can't observe the HTTP status of a failed upgrade — a refusal and a transient
  failure close identically before `open` — so a WS pre-`open` close
  backoff-retries; the one terminal WS signal is a `4403` policy close on an
  established socket.
- The control plane (`/__rpxd/ws|stream|rpc|control`) is **same-origin by
  default** — checked before authentication. The same-origin policy does not
  apply to WebSocket handshakes, so an Origin check is the defense against
  cross-site WebSocket hijacking (and blind cross-site POST). A cross-origin
  `Origin` that isn't allow-listed gets `403`; an absent `Origin` (non-browser
  clients) is allowed. Widen with `allowedOrigins` in `rpxd.config.ts`. SSR `GET`
  and `route()` handlers are **not** gated — a top-level navigation is
  legitimately cross-site.
- The server evicts an instance when subscribers reach 0, after a warm TTL
  (~60s): snapshot to storage, drop from memory. Cold wake re-runs `mount` (see
  [snapshots are continuity, not cache](/rpxd-live/concepts/persistence/#snapshots-are-continuity-not-cache);
  spec §9).
- **Disconnect mid-handler does not abort the handler.** A dropped stream only
  unsubscribes and re-arms the warm-TTL evict timer; the handler keeps running to
  completion, and its ack is produced and **cached** for re-ack. `ctx.signal`
  aborts later, at dispose/eviction after the warm TTL expires (or on an explicit
  `ctx.abort` / a superseding URL change) — not on the disconnect itself. On
  reconnect the client resends unacked batches; the dedupe window returns the
  cached ack without re-running.

## SSE framing

- Endpoint: `GET /__rpxd/stream` (one per connection, all instances
  multiplexed). SSR adoption and the stream id ride the query string:
  `?attach=<token>&seq=<n>&stream=<id>`.
- Each envelope is one SSE event: `event: env`, `data: <json>`, SSE `id:`
  mirrors `seq` for proxy-level resume hints (authoritative resume is still
  `resync`).
- Upstream on SSE mode: `POST /__rpxd/rpc` (batch) and `POST /__rpxd/control`.

## WS framing

- Single duplex socket, endpoint `GET /__rpxd/ws` (upgrade); SSR adoption rides
  the same `?attach=<token>&seq=<n>` query params. Every message is one JSON
  object: envelopes downstream, batches/controls upstream. No other
  differences — same envelope, same seq rules, same recovery.

## Invariants (test these)

Pinned by `packages/core/test/protocol-conformance.test.ts`.

1. Applying `patches` in seq order over the last `full` always equals server
   confirmed state.
2. Every batch gets exactly one ack (`rpcId`) — success or `error` — unless the
   connection dies; then resend + dedupe makes delivery effectively once.
3. A client that only understands `full` (ignores all patches, resyncs every
   gap) still converges.
4. Envelopes for one instance never interleave out of seq order, regardless of
   transport.
