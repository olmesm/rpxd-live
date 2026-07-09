# @rpxd/core

The rpxd server runtime: live objects, the patch engine, and the wire
protocol. Everything else — transports, storage, the CLI — plugs into the
seams defined here.

Most apps never install this directly beyond importing `live()`; the
[`@rpxd/cli`](../cli) shell wires the rest.

## What lives here

- **`live(path)`** — the fluent route builder. State locks at `.setup()` (sync;
  wires subscriptions), `.guard()` gates access (auth), `.load()` is the URL
  loader, payloads lock at `.input()`, and `.render()` hands the component fully
  typed props with an exact-keyed `rpc` facade. Zero annotations.
- **`route(path)`** — the fluent builder for plain HTTP endpoints (webhooks,
  auth delegation): `.get`/`.post`/… implement a method, `.all` forwards a
  whole subtree. Same path typing as `live()`, none of the state machinery.
- **`redirect(to)`** — thrown from `guard` (auth's home) — or `setup`/`load` — to
  bounce (e.g. an unauthenticated visitor). A full load becomes a `302`; a soft
  navigation gets a `{ redirect }` signal the client router follows.
  `isRedirect()` recognises it.
- **`LiveInstance`** — one mounted live object: a per-instance FIFO queue
  serializes mutations, handlers run off-queue (`await` never blocks the
  instance), and every `ctx.patchState` flush becomes one atomic Immer patch
  envelope. String-suffix growth compiles to `append` ops so token streams
  are O(delta) on the wire.
- **Protocol types** — the `{ seq, patches | full, rpcId?, idMap?, error? }`
  envelope and rpc batch shapes. Transport-agnostic; the normative document
  is [`docs/protocol.md`](../../docs/protocol.md).
- **Storage seam** — `StorageAdapter` (`get`/`set` of snapshots + the pubsub
  bus). `memory()` ships here as the default; see the `@rpxd/storage-*`
  packages for the rest.
- **`matchPath`/`matchRoute`** (pages) and **`matchHttpPath`/`matchHttpRoute`**
  (HTTP routes, incl. the trailing `$` catch-all) — the URL matchers client
  and server share.

## Key concepts

**Handlers orchestrate; mutators write.** Handlers are plain async
functions `(payload, ctx)`. All state writes go through
`ctx.patchState(mut)` — a sync Immer mutator on a fresh draft, so drafts
can never escape across an `await`. `ctx.state` is a live read-only view
(reads after `await` see current state). Streaming is just a loop:

```ts
.rpc("ask", (r) =>
  r.input(z.object({ prompt: z.string() })).handler(async ({ prompt }, ctx) => {
    for await (const delta of llm.stream(prompt, { signal: ctx.signal })) {
      ctx.patchState((s) => { s.answer += delta; }); // one envelope per tick
    }
  }),
)
```

**`.atomic()`** opts a whole rpc back into buffer-and-rollback.
**`ctx.signal`** aborts on disconnect/eviction; **`ctx.abort(name)`** is the
stop-generating pattern. **`ctx.broadcast`/`.on()`** ride the storage bus
for multiplayer — per-session instances, no shared state.

The normative spec is [`spec.md`](../../spec.md).
