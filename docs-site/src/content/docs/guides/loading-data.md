---
title: Loading data
description: The load loader — the single place URL-dependent data loads. Runs after setup and on every nav.patch, writes page state, latest-wins, streams by default.
sidebar:
  order: 2
---

This page shows where data loading lives in an rpxd page: **`load`**, the
single place URL-dependent data loads. `setup` builds the state that doesn't
depend on the URL; `load` runs once after it (first paint) and again on every
`nav.patch`. Every pattern in [pagination](/rpxd-live/guides/pagination/),
[infinite scroll](/rpxd-live/guides/infinite-scroll/), and [filtering &
search](/rpxd-live/guides/filtering-and-search/) builds on it.

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

On the client there is exactly one way to change a view: **`nav.patch`**.
Calling it updates the URL, and the URL change runs the loader. There is no
paired "load" rpc and no `useEffect`. See [Routing](/rpxd-live/guides/routing/)
for how `nav.patch` updates the URL without re-running `setup`.

## The URL is the query key

Because filters, pages, and cursors live in the URL, the views built on the
loader are **shareable, bookmarkable, and back-button-correct** for free. When
an instance is rebuilt from scratch (a cold wake), `setup` re-runs and the
loader rebuilds the exact window from the URL — no "remember where I was" state
required. A full-page load of a
filtered URL reconciles a warm instance to that URL too.

## Three things you get without extra API

**keepPreviousData is free.** Don't null the list before fetching — flip a
`loading` flag. The previous window stays on screen (rendered with `aria-busy`)
until the new one lands. It falls out of `patchState`, not a cache.

**Loading, empty, and error are just state.** The loader sends no completion
message. Set `s.loading` / `s.error` yourself and render off them:

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
everything after it. An `async` function runs synchronously up to its first
`await`. So the whole choice is where you put the first `patchState` relative
to the first `await` — no flag:

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

`load` writes **page state** through `ctx.patchState`, typed from `setup` the
same as an rpc handler. `ctx.state` is a read-only view. The **first argument
is the whole URL**: `{ params, search }`. `params` (from `/org/$orgId`) are
typed, like everywhere else. `search` is untyped view state
(`Record<string, string | undefined>`) — narrow and default it yourself
(`search.filter ?? "open"`). And there's no built-in `paginated()` helper: the
patterns that follow are ~15-line loaders, because the loader already is the
abstraction.

Next: [Pagination](/rpxd-live/guides/pagination/),
[Infinite scroll](/rpxd-live/guides/infinite-scroll/), and
[Filtering & search](/rpxd-live/guides/filtering-and-search/).
