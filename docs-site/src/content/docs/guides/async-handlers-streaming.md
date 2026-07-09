---
title: Async handlers & streaming
description: Handlers are plain async functions; patchState is the only write; awaits never block the instance. How token streams become O(delta) on the wire.
sidebar:
  order: 2
---

Handlers are plain `async (payload, ctx)` functions. The one rule: **all state
writes go through `ctx.patchState(mutator)`**, a synchronous Immer mutator on a
fresh draft. Every flush produces exactly one patch envelope.

## Awaits never block the instance

A per-instance FIFO queue serializes *mutations* (patchState flushes, `on`
handlers, `params`) — last-write-wins by ordering. But handlers never hold the
queue across an `await`: other rpcs, broadcasts, and `params` run freely while a
handler waits. Concurrency is the default, with no flag.

`ctx.state` is a live, read-only view: reads after an `await` see current state.
Writes to it throw — use `ctx.patchState`.

## Streaming is just a loop

Because each `patchState` is one envelope, streaming is a `for await` loop. And
because string-suffix growth compiles to an `append` patch op carrying only the
delta, a token stream is **O(delta)** on the wire, not O(total):

```ts
.rpc("ask", (r) =>
  r.input(z.object({ prompt: z.string() })).handler(async ({ prompt }, ctx) => {
    ctx.patchState((s) => {
      s.answer = "";
      s.thinking = true;
    });
    const stream = llm.stream(prompt, { signal: ctx.signal });
    for await (const delta of stream) {
      ctx.patchState((s) => {
        s.answer += delta; // → append op, O(delta) on the wire
      });
    }
    ctx.patchState((s) => {
      s.thinking = false;
    });
  }),
)
.rpc("stop", (r) => r.handler(async (_p, ctx) => ctx.abort("ask")));
```

## Coalescing and all-or-nothing

- Same-tick `patchState` calls from one rpc **coalesce** into a single flush →
  one envelope.
- **Whole-rpc all-or-nothing is control flow, not a flag.** Do the fallible work
  first (or wrap it in `try/catch`), accumulate results in locals, then
  `patchState` **once** at the end — a throw before that terminal write applies
  nothing. This is strictly more flexible than a rollback flag: a `catch` can
  recover, partially commit, or rethrow.

## Cancellation

- **`ctx.signal`** aborts on disconnect or eviction. Pass it to `fetch` and SDK
  calls so in-flight work winds down; `finally` blocks still run.
- **`ctx.abort(name)`** aborts in-flight invocations of a named rpc — the
  "stop generating" pattern above.

## The stale-draft bug class is gone

Because the Immer draft only exists inside the `patchState` callback and never
escapes it, you cannot hold a draft across an `await`. That entire class of bug
is structurally impossible — no lint rule required.

## Errors

When a handler throws, the draft is discarded and the ack is rejected. If the
rpc declared `.onError`, that sync mutator runs as a queued flush and its
repairs ride the error ack. `sync.errors` is populated on the client. **Database
atomicity stays your responsibility** — wrap writes in a transaction inside your
`domain/` function; `onError` repairs *state*, not the database.
