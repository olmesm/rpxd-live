# ADR 0001 — RPC rollback and SSR sequencing

- Status: accepted
- Date: 2026-07-09

## Context

Two design questions on the `live()` fluent chain, resolved together because
each turned on the same principle — prefer a rule the runtime already follows
over a flag bolted onto it:

1. **RPC rollback** — a handler may throw partway through, after some
   `patchState` calls have already landed. How does a handler express
   *whole-rpc all-or-nothing* (a throw leaves nothing applied)?
2. **SSR sequencing** — during SSR the loader has a synchronous prefix and
   awaited work. What goes in the first document, and what streams after?

## Decision 1 — RPC rollback is userland control flow

**Options considered**

- **A. An `.atomic()` step** that buffers every `patchState` call and flushes
  once on success, discarding all of them on a throw.
- **B. No flag.** Do the fallible work first (or wrap it in `try/catch`),
  accumulate in locals, then `patchState` **once** at the end.

**Chosen: B.**

`.atomic()` adds no capability. Any atomic handler rewrites to "await the
fallible work, then a single terminal `patchState`" with identical observable
behaviour — a throw before that write applies nothing, exactly like a discarded
buffer. Because atomic suppresses intermediate streaming anyway, "I didn't want
the partial writes visible" and "so I won't write them until the end" are the
same statement.

B is also *more* expressive: `.atomic()` is all-or-nothing with no middle
ground, whereas a `catch` can recover, partially commit, or rethrow. `.onError`
remains for repairing _state_ after a throw; database atomicity was never
`.atomic()`'s concern (it repaired state, not the DB) and stays a userland
transaction in the `domain/` layer. Net: one fewer flush model to learn and to
maintain.

## Decision 2 — SSR sequencing follows the first-patch rule

**Options considered**

- **A. Two modes.** Stream by default (serialize the synchronous prefix, stream
  the awaited data); opt into `blockSsr` to await the whole loader before
  serializing.
- **B. The first-patch rule.** The first document always carries state through
  the loader's **first patch**; everything after it streams. Because an `async`
  function runs synchronously up to its first `await`, the author controls the
  outcome by *where the first `patchState` sits relative to the first `await`*:

  ```ts
  // first patch is synchronous → renders now, data streams (fast TTFB)
  ctx.patchState(s => { s.loading = true });
  const rows = await db.query();
  ctx.patchState(s => { s.rows = rows });

  // await before the first patch → renderer waits (crawlable, data-complete)
  const rows = await db.query();
  ctx.patchState(s => { s.rows = rows });
  ```

- **C. Auto crawler-aware sequencing.** Always stream for JS clients; block for
  crawlers/no-JS via user-agent detection.

**Chosen: B.**

`blockSsr` was only ever "move the render snapshot to after the `await`," and
that timing is already determined by the loader's shape — so option A is a
redundant flag that also introduces an *exception* to the otherwise-uniform
"synchronous renders, awaited streams" rule the runtime uses everywhere else.
Option B makes that rule universal, encodes intent in structure, and is more
granular than the flag ever was (it blocks until the first patch, not the whole
loader, so a loader can render its critical data and still stream secondary
data).

Option A was rejected as a redundant special case. Option C was rejected as
implicit and environment-dependent (fragile bot lists, bot-vs-human HTML
divergence) — against the framework's explicit-contract grain. The trade-off B
keeps: an author must know that a synchronous patch means "render now." That is
a one-line rule, and it aligns with intent — you emit a synchronous projection
precisely when you want a spinner, i.e. when you're streaming.

## Consequences

- The runtime renders through the loader's first patch (`LiveInstance.load
  ForRender`), resolving at that patch or when the run settles with no patch (it
  then renders the `setup` skeleton). A redirect thrown before the first patch
  still 302s; one thrown after is mid-stream — use `guard` for redirects that
  must always fire.
- The chain carries **no rollback flag and no SSR flag**. A loader that awaits
  before patching is crawlable with no annotation; one with a synchronous
  projection streams. A route that wants a data-complete first paint restructures
  to await-first (drop the synchronous projection).
- Every `patchState` streams through the instance-global pending list; there is
  no per-rpc write buffer.
