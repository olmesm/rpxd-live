---
title: Async handlers & streaming
description: Handlers are plain async functions; patchState is the only write; awaits never block the instance. How token streams become O(delta) on the wire.
sidebar:
  order: 8
---

This page shows how to write handlers that do slow or streaming work — an LLM
token stream, a long import — without blocking anything else on the page.

Handlers are plain `async (payload, ctx)` functions. The one rule: **all state
writes go through `ctx.patchState(mutator)`**, a synchronous Immer mutator on a
fresh draft. Every flush — a round of writes sent to clients — produces exactly
one patch message.

## Streaming is just a loop

Because each `patchState` flushes as one message, streaming is a `for await`
loop. And
string-suffix growth (`s.answer += delta`) compiles to an `append` patch op
carrying only the delta — so a token stream costs **O(delta)** on the wire,
not O(total):

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

## Awaits never block the instance

While the handler above waits on the stream, other rpcs, broadcasts, and
events run freely. Concurrency is the default, with no flag.

Under the hood, a per-instance FIFO queue serializes *mutations*: `patchState`
writes, broadcast publishes, and `on`-event delivery. Ordering decides
conflicts — last write wins. Handlers never hold that queue across an `await`.

`ctx.state` is a live, read-only view: reads after an `await` see current state.
Writes to it throw — use `ctx.patchState`.

## Coalescing, and making an rpc all-or-nothing

- Same-tick `patchState` calls from one rpc **coalesce** into a single patch
  message.
- To make a whole rpc all-or-nothing, use ordinary control flow — there is no
  rollback flag. Do the fallible work first (or wrap it in `try/catch`),
  accumulate results in local variables, then `patchState` **once** at the end.
  A throw before that final write applies nothing. Control flow is also more
  flexible than a flag: a `catch` can recover, partially commit, or rethrow.

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

When a handler throws, the draft is discarded and the rpc's ack — the server's
acknowledgment of the call — comes back as an error. `sync.errors` is populated
on the client. If the rpc declared `.onError`, that sync mutator runs as a
queued write, and the patches it produces travel back with the error ack.
**Database atomicity stays your responsibility** — wrap writes in a transaction
inside your `domain/` function; `onError` repairs *state*, not the database.

## Testing

Drive a streaming handler with [`testLive`](/rpxd-live/guides/testing/), await
`t.settled()`, then assert both the final `t.state` and the mid-handler chunks
— the envelopes (wire messages) in `t.envelopes` with `patches` and no `rpcId`.
