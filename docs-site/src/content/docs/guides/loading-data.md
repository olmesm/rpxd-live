---
title: Loading data
description: The params loader — the single place URL-dependent data loads. Runs after mount and on every nav.patch, writes page state, latest-wins, streams by default.
sidebar:
  order: 8
---

`mount` sets up what's true regardless of the URL; **`params` is the loader** —
the single place URL-dependent data loads. It runs once after `mount` (first
paint) and again on every `nav.patch`, and it's the foundation every pattern in
the next few guides builds on.

```tsx
export default live("/issues")
  // once per page load: URL-invariant setup only
  .mount(async (_p, ctx) => ({ items: [] as Issue[], filter: "open", loading: true }))
  // THE loader: after mount + on every nav.patch, keyed to the URL
  .params(async ({ filter }, ctx) => {
    ctx.patchState((s) => { s.filter = filter ?? "open"; s.loading = true; }); // projection
    const items = await listIssues(scopeFrom(ctx.session), {
      filter: filter ?? "open", signal: ctx.signal,
    });
    ctx.patchState((s) => { s.items = items; s.loading = false; });            // data
  })
  .render(({ state, nav }) => (
    <main>
      <FilterTabs value={state.filter} onChange={(f) => nav.patch({ filter: f })} />
      <ul aria-busy={state.loading}>{state.items.map((i) => <Row key={i.id} {...i} />)}</ul>
    </main>
  ));
```

## The model

Split every piece of state by **cadence**:

- Does it depend on the URL's search params? No → `mount` (runs once). Yes →
  `params` (runs on every change).
- Is it changed by the user *acting*, not *navigating*? → `rpc`.

On the client there is exactly one verb for changing a view: **`nav.patch`** —
and it *is* the reload, because it's what triggers the loader. No paired "load"
rpc, no `useEffect`. See [Routing](/rpxd-live/guides/routing/) for how
`nav.patch` updates the URL without a remount.

## The URL is the query key

Because filters, pages, and cursors live in the URL, the views built on the
loader are **shareable, bookmarkable, and back-button-correct** for free. On a
cold wake the instance re-runs `mount` and the loader rebuilds the exact window
from the URL — no "remember where I was" state required. A full-page load of a
filtered URL reconciles a warm instance to that URL too.

## Three things you get without extra API

**keepPreviousData is free.** Don't null the list before fetching — flip a
`loading` flag. The previous window stays on screen (rendered with `aria-busy`)
until the new one lands. It falls out of `patchState`, not a cache.

**Loading, empty, and error are just state.** There's no loader ack. Set
`s.loading` / `s.error` yourself and render off them:

```tsx
.params(async (search, ctx) => {
  ctx.patchState((s) => { s.loading = true; s.error = null; });
  try {
    const items = await list(search, { signal: ctx.signal });
    ctx.patchState((s) => { s.items = items; s.loading = false; });
  } catch {
    ctx.patchState((s) => { s.loading = false; s.error = "Couldn't load."; });
  }
})
```

**Latest-wins.** A newer `nav.patch` aborts the prior loader run's `ctx.signal`
and discards its late writes, so rapid changes resolve to the *last* URL, not to
whichever query returned last. Always pass `ctx.signal` to `fetch`/SDK calls so a
superseded load stops early.

## SSR: stream by default, `blockSsr` to opt in

The loader runs synchronously up to its first `await`, so its projection (the
filter/loading chrome) is staged the instant control returns. By default that
projection is serialized into the first document and the awaited data **streams
in** over the push stream after hydration — fast TTFB, but a crawler/no-JS
client sees the chrome, not the rows.

Pass `{ blockSsr: true }` to await the full load before serializing, so the first
paint carries data (crawlable, no spinner) at the cost of TTFB:

```tsx
.params(async (search, ctx) => { /* … */ }, { blockSsr: true })
```

Either way the capture is deterministic — keyed to what the loader has *staged*,
never a timer.

## What the loader is not

`params` writes **page state** through `ctx.patchState` (typed from `mount`, same
as an rpc handler); `ctx.state` is a read-only view. The **first argument is the
*search* params** — untyped view state (`Record<string, string | undefined>`),
so narrow and default it yourself (`search.filter ?? "open"`). **Path** params (`/org/$orgId`) are separate: they're
on `ctx.params`, typed, like everywhere else. And there's no built-in `paginated()` helper: the
patterns that follow are ~15-line loaders, because the loader already is the
abstraction.

Next: [Pagination](/rpxd-live/guides/pagination/),
[Infinite scroll](/rpxd-live/guides/infinite-scroll/), and
[Filtering & search](/rpxd-live/guides/filtering-and-search/).
