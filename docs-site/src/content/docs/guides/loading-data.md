---
title: Loading data
description: The load loader — the single place URL-dependent data loads. Runs after setup and on every nav.patch, writes page state, latest-wins, streams by default.
sidebar:
  order: 8
---

`setup` sets up what's true regardless of the URL; **`load` is the loader** —
the single place URL-dependent data loads. It runs once after `setup` (first
paint) and again on every `nav.patch`, and it's the foundation every pattern in
the next few guides builds on.

```tsx
export default live("/issues")
  // once per page load: URL-invariant skeleton only, and SYNC — no IO here
  .setup(() => ({ items: [] as Issue[], filter: "open", loading: true }))
  // THE loader: after setup + on every nav.patch, keyed to the URL
  .load(async ({ search }, ctx) => {
    const filter = search.filter ?? "open";
    ctx.patchState((s) => { s.filter = filter; s.loading = true; });          // projection
    const items = await listIssues(scopeFrom(ctx.session), {
      filter, signal: ctx.signal,
    });
    ctx.patchState((s) => { s.items = items; s.loading = false; });           // data
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

- Does it depend on the URL's search params? No → `setup` (runs once, sync). Yes →
  `load` (runs on every change).
- Is it changed by the user *acting*, not *navigating*? → `rpc`.
- Is it access control? → `guard` (runs before `load` on every URL change) — see
  [HTTP routes & auth](/rpxd-live/guides/routes-and-auth/).

Because `setup` is synchronous, "all data loads in `load`" is a structural
guarantee, and a same-route path step's skeleton is instant.

On the client there is exactly one verb for changing a view: **`nav.patch`** —
and it *is* the reload, because it's what triggers the loader. No paired "load"
rpc, no `useEffect`. See [Routing](/rpxd-live/guides/routing/) for how
`nav.patch` updates the URL without re-running `setup`.

## The URL is the query key

Because filters, pages, and cursors live in the URL, the views built on the
loader are **shareable, bookmarkable, and back-button-correct** for free. On a
cold wake the instance re-runs `setup` and the loader rebuilds the exact window
from the URL — no "remember where I was" state required. A full-page load of a
filtered URL reconciles a warm instance to that URL too.

## Three things you get without extra API

**keepPreviousData is free.** Don't null the list before fetching — flip a
`loading` flag. The previous window stays on screen (rendered with `aria-busy`)
until the new one lands. It falls out of `patchState`, not a cache.

**Loading, empty, and error are just state.** There's no loader ack. Set
`s.loading` / `s.error` yourself and render off them:

```tsx
.load(async ({ search }, ctx) => {
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

## SSR: the first document carries state through the loader's first patch

The renderer serializes state through the loader's **first patch** and streams
everything after it. Because an `async` function runs synchronously up to its
first `await`, *where you put the first `patchState` relative to the first
`await`* is the whole choice — no flag:

```tsx
// Patch before the await → the projection renders now, data streams in.
.load(async ({ search }, ctx) => {
  ctx.patchState((s) => { s.filter = f; s.loading = true; }); // ← first paint (fast TTFB)
  const items = await listItems(f);
  ctx.patchState((s) => { s.items = items; s.loading = false; }); // ← streams after hydration
})

// Await the data before the first patch → the renderer waits for it.
.load(async ({ search }, ctx) => {
  const items = await listItems(searchToFilter(search)); // no patch yet
  ctx.patchState((s) => { s.items = items; }); // ← first paint (crawlable, data-complete)
})
```

A crawler/no-JS client sees whatever is in that first document, so `await`
before the first patch when the data must be crawlable. Either way the capture
is deterministic — keyed to the first patch, never a timer.

## What the loader is not

`load` writes **page state** through `ctx.patchState` (typed from `setup`, same
as an rpc handler); `ctx.state` is a read-only view. Its **first argument is the
whole URL** — `{ params, search }`. `search` is untyped view state
(`Record<string, string | undefined>`), so narrow and default it yourself
(`search.filter ?? "open"`). `params`
(from `/org/$orgId`) are typed, like everywhere else. And there's no built-in
`paginated()` helper: the patterns that follow are ~15-line loaders, because the
loader already is the abstraction.

Next: [Pagination](/rpxd-live/guides/pagination/),
[Infinite scroll](/rpxd-live/guides/infinite-scroll/), and
[Filtering & search](/rpxd-live/guides/filtering-and-search/).
