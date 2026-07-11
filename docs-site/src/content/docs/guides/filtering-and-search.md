---
title: Filtering & search
description: Filters, sort, and debounced text search as URL search params on the `load` loader — resetting the cursor on filter change, and why latest-wins makes typeahead clean.
sidebar:
  order: 7
---

Filters, sort, and a search box are all just search params read by the
[loader (`load`)](/rpxd-live/guides/loading-data/). Each is a `nav.patch`; the URL
stays the source of truth, so the view is shareable and back-button-correct.

```tsx
export default live("/issues")
  .setup(() => ({ items: [] as Issue[], filter: "open", sort: "newest", loading: true }))
  .load(async ({ search }, ctx) => {
    const f = search.filter ?? "open";
    const s = search.sort ?? "newest";
    ctx.patchState((st) => { st.filter = f; st.sort = s; st.loading = true; });
    const items = await listIssues(scopeFrom(ctx.session), { filter: f, sort: s, signal: ctx.signal });
    ctx.patchState((st) => { st.items = items; st.loading = false; });
  })
  .render(({ state, nav }) => (
    <main>
      <FilterTabs value={state.filter} onChange={(f) => nav.patch({ filter: f })} />
      <SortMenu value={state.sort} onChange={(s) => nav.patch({ sort: s })} />
      <ul aria-busy={state.loading}>{state.items.map((i) => <Row key={i.id} {...i} />)}</ul>
    </main>
  ));
```

The first `patchState` runs synchronously, so `filter`/`sort`/`loading` flip
the tab instantly and land in the SSR first paint. The awaited rows stream in
after (see [SSR](/rpxd-live/concepts/ssr/)). If the rows must be crawlable,
`await` them before the first `patchState` instead — the renderer then waits
for that patch. The
[kitchen-sink example](/rpxd-live/examples/kitchen-sink/) is a working version of this.

## Reset the cursor when a filter changes

If you combine filtering with [pagination](/rpxd-live/guides/pagination/), a
filter change must **drop the cursor/page** — otherwise page 3 of the *old*
filter bleeds into the *new* one. Since the URL is the query key, resetting is
just omitting `cursor` from the patch:

```tsx
// changing the filter starts a fresh window
onChange={(f) => nav.patch({ filter: f })}        // no cursor → page 1
// paging within the current filter keeps it
onClick={() => nav.patch({ filter: state.filter, cursor: state.cursor! })}
```

## Debounced text search

A search box is a search param like any other — debounce the keystrokes into a
`nav.patch`, and let **latest-wins** do the rest: each keystroke's loader run
aborts the previous one's `ctx.signal`, so a slow query for `"fo"` can't land
after `"foobar"`.

```tsx
const [q, setQ] = useState(state.query ?? "");
useEffect(() => {
  const id = setTimeout(() => nav.patch({ q, cursor: "" }), 200); // reset window on new query
  return () => clearTimeout(id);
}, [q]);

return <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search…" />;
```

On the server the loader just reads `search.q` and passes it — and because it
threads `ctx.signal` into the query, superseded searches stop early instead of
racing:

```tsx
.load(async ({ search }, ctx) => {
  ctx.patchState((s) => { s.query = search.q ?? ""; s.loading = true; });
  const items = await searchIssues(scopeFrom(ctx.session), { q: search.q ?? "", signal: ctx.signal });
  ctx.patchState((s) => { s.items = items; s.loading = false; });
})
```

## Empty and error states

Filtering routinely produces empty results. Render them off state, the same way
as loading and errors — the loader sends no completion message; everything is
state it writes:

```tsx
{state.loading ? <Spinner />
 : state.error ? <Error msg={state.error} onRetry={() => nav.patch({ filter: state.filter })} />
 : state.items.length === 0 ? <Empty>No matches.</Empty>
 : <ul>{state.items.map((i) => <Row key={i.id} {...i} />)}</ul>}
```
