# @rpxd/core

The rpxd server runtime: live objects, the patch engine, and the wire
protocol types. Everything else — transports, storage, the CLI — plugs into
interfaces defined here.

Most apps never touch this package directly beyond importing `live()`; the
[`@rpxd/cli`](../cli) shell wires the rest.

## What lives here

- **`live(path)`** — the fluent route builder. `.setup()` locks the state
  shape (sync; wires subscriptions), `.guard()` gates access (auth),
  `.load()` loads data for the URL, `.rpc()` declares typed calls with
  `.input()` locking their payloads, and `.render()` hands the component
  fully typed props including the `rpc` facade. No type annotations needed.
- **`route(path)`** — the fluent builder for plain HTTP endpoints (webhooks,
  auth delegation). `.get`/`.post`/… implement a method; `.all` forwards a
  whole subtree. Same path typing as `live()`, none of the state machinery.
- **`redirect(to)`** — throw it from `guard` (its usual home), `setup`, or
  `load` to bounce a visitor (e.g. someone unauthenticated). A full page
  load becomes a `302`; a soft navigation gets a `{ redirect }` signal the
  client router follows. `isRedirect()` recognises it.
- **`LiveInstance`** — one mounted live object. A per-instance FIFO queue
  serializes mutations, and handlers run off-queue, so `await` never blocks
  the instance. Every `ctx.patchState` flush becomes one Immer patch
  envelope. Growing a string by suffix compiles to `append` ops, so token
  streams send only the new text.
- **Protocol types** — the `{ seq, patches | full, rpcId?, idMap?, error? }`
  envelope and rpc batch shapes. Transport-agnostic; the normative document
  is the [Wire protocol](https://olmesm.github.io/rpxd-live/concepts/wire-protocol/).
- **Storage interface** — `StorageAdapter`: `get`/`set` of snapshots plus
  the pubsub bus. `memory()` ships here as the default; see the
  `@rpxd/storage-*` packages for the rest.
- **URL matchers** — `matchPath`/`matchRoute` for pages,
  `matchHttpPath`/`matchHttpRoute` for HTTP routes (including the trailing
  `$` catch-all). Client and server share them.

## Key concepts

**Handlers orchestrate; mutators write.** Handlers are plain async
functions `(payload, ctx)`. All state writes go through
`ctx.patchState(mut)` — a sync Immer mutator on a fresh draft, so a draft
can never escape across an `await`. `ctx.state` is a live read-only view
(reads after an `await` see current state). Streaming is just a loop:

```ts
.rpc("ask", (r) =>
  r.input(z.object({ prompt: z.string() })).handler(async ({ prompt }, ctx) => {
    for await (const delta of llm.stream(prompt, { signal: ctx.signal })) {
      ctx.patchState((s) => { s.answer += delta; }); // one envelope per tick
    }
  }),
)
```

**All-or-nothing rpcs are your app's job.** Do the fallible work first (or
`try/catch` and accumulate), then `patchState` once at the end. `.onError`
repairs state after a throw.

**`ctx.signal`** aborts on disconnect or eviction; **`ctx.abort(name)`** is
the stop-generating pattern. **`ctx.broadcast` / `.on()`** ride the storage
bus for multiplayer — instances are per-session and share no state.

The normative spec is [`spec.md`](../../spec.md). Docs:
https://olmesm.github.io/rpxd-live/
