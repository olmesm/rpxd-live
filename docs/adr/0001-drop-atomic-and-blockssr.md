# ADR 0001 — Drop `.atomic()` and `blockSsr`

- Status: accepted
- Date: 2026-07-09

## Context

Two boolean-flavoured flags had accreted onto the fluent chain:

- **`.atomic()`** on an rpc — buffer every `patchState` call, flush once on
  success, discard all on throw (whole-rpc rollback).
- **`blockSsr`** on `.load()` — await the whole loader before serializing the
  first document, instead of streaming.

They looked like a pair (two framework flags with SSR/transaction-shaped
names) but govern unrelated concerns. Reviewing them together, each turned out
to be removable — one because it is sugar, the other because it is emergent
from a rule the runtime already follows.

## Decision

Remove both. Keep zero flags.

### `.atomic()` is sugar over control flow

Anything `.atomic()` did is expressible in userland with identical observable
behaviour: do the fallible async work first, accumulate results in locals, then
`patchState` **once** at the end. A throw before that terminal write leaves
nothing applied — same as a discarded atomic buffer. Where writes are scattered
(loops, helpers), a `try/catch` plus accumulation covers it, and is strictly
_more_ expressive: `.atomic()` fails all-or-nothing with no middle ground,
whereas a catch can recover, partially commit, or rethrow.

`.onError` remains for repairing _state_ after a throw. Database atomicity was
never `.atomic()`'s job (it repaired state, not the DB) and stays a userland
transaction inside the `domain/` layer.

### `blockSsr` is emergent from the first-patch render rule

The runtime already renders **state through the loader's first patch** and
streams everything after it. An async function runs synchronously up to its
first `await`, so the loader's synchronous prefix is available the instant it
hands back control:

```ts
// first patch is synchronous → render immediately, stream the rest
async load(url, ctx) {
  ctx.patchState(s => { s.loading = true }); // ← rendered (fast TTFB)
  const rows = await db.query();
  ctx.patchState(s => { s.rows = rows });     // ← streams after hydration
}

// no synchronous patch → the renderer waits for the first patch
async load(url, ctx) {
  const rows = await db.query();
  ctx.patchState(s => { s.rows = rows });     // ← rendered (crawlable, data-complete)
}
```

`blockSsr` was just "move the render snapshot to after the `await`." That
choice is fully determined by **where the loader's first `patchState` sits
relative to its first `await`** — which the author already controls by writing
the loader. So the flag is redundant:

- **Want fast TTFB + streaming?** Emit a synchronous `patchState` (chrome /
  `loading: true`) before the `await`. Render fires on it; data streams.
- **Want a crawlable, data-complete first paint?** `await` the data _before_
  the first `patchState`. The renderer blocks for that patch; nothing streams.

The rule is uniform — the same "sync renders, async streams" model already used
for rpc handlers now has no exception.

## Consequences

- The runtime waits for the loader's first patch before serializing (or until
  the loader settles with no patch, in which case it renders the `setup`
  skeleton). A redirect thrown before the first patch still 302s; one thrown
  after is mid-stream (use `guard` for redirects that must always fire).
- A loader that previously relied on `blockSsr` and awaited before patching
  behaves identically. One that emitted a synchronous projection now streams
  the awaited data (previously `blockSsr` folded it into the first paint) —
  restructure to await-first if a data-complete paint is required.
- `LoaderOptions` / the second `.load()` argument, and the `.atomic()` chain
  step + `RpcLongForm.atomic`, are gone. The per-rpc flush buffer machinery
  (`FlushBucket`) is deleted; every `patchState` streams through the
  instance-global pending list.

## Alternatives considered

- **Keep `blockSsr`, relocate it** (route/config level rather than an option
  bag). Rejected: it is not a knob at all once the first-patch rule is stated.
- **Auto crawler-aware sequencing** (stream for JS clients, block for bots via
  UA sniffing). Rejected: implicit, env-dependent, and against the framework's
  explicit-contract grain.
