---
title: Pagination
description: Cursor and offset pagination built on the `load` loader — page/cursor in the URL, prev/next via nav.patch, replace-window with keepPreviousData.
sidebar:
  order: 5
---

Pagination is a [loader (`load`)](/rpxd-live/guides/loading-data/) that reads a
page or cursor from the URL and **replaces** the window. The page lives in the
URL, so it's shareable and back-button-correct; the previous page stays visible
while the next loads.

## Cursor-based (recommended for feeds)

Cursors are stable under inserts and deletes — the right default for anything
ordered by time or id. The loader reads `cursor` from the URL and asks the
domain layer for the next window plus the cursor that follows it:

```tsx
export default live("/issues")
  .setup(() => ({ items: [] as Issue[], cursor: null as string | null, hasMore: false, loading: true }))
  .load(async ({ search }, ctx) => {
    // Await the data before the first patch: SSR waits for it, so the first
    // page is part of the initial document (crawlable).
    const { items, nextCursor } = await listIssues(scopeFrom(ctx.session), {
      cursor: search.cursor ?? null, limit: 20, signal: ctx.signal,
    });
    ctx.patchState((s) => {
      s.items = items;                       // replace the window
      s.cursor = nextCursor;
      s.hasMore = nextCursor != null;
      s.loading = false;
    });
  })
  .render(({ state, nav, keyOf }) => (
    <main>
      <ul aria-busy={state.loading}>
        {state.items.map((i) => <li key={keyOf(i.id)}>{i.title}</li>)}
      </ul>
      {state.hasMore && (
        <button onClick={() => nav.patch({ cursor: state.cursor! })}>Next</button>
      )}
    </main>
  ));
```

Awaiting the data before the first `patchState` makes the first page part of
the initial document (crawlable — see [SSR](/rpxd-live/concepts/ssr/)). Each "Next" is a `nav.patch({ cursor })`
— the URL changes, the loader reruns, the window replaces.

## Offset-based (jump-to-page + totals)

When you need numbered pages or a total count, read a `page` number instead. The
`limit`/`offset` are derived; return the total so the UI can render a pager:

```tsx
const PAGE_SIZE = 20;

export default live("/issues")
  .setup(() => ({ items: [] as Issue[], page: 1, pageCount: 1, loading: true }))
  .load(async ({ search }, ctx) => {
    const p = Math.max(1, Number(search.page ?? "1"));
    const { items, total } = await listIssues(scopeFrom(ctx.session), {
      limit: PAGE_SIZE, offset: (p - 1) * PAGE_SIZE, signal: ctx.signal,
    });
    ctx.patchState((s) => {
      s.page = p;
      s.items = items;
      s.pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
      s.loading = false;
    });
  })
  .render(({ state, nav, keyOf }) => (
    <main>
      <ul aria-busy={state.loading}>
        {state.items.map((i) => <li key={keyOf(i.id)}>{i.title}</li>)}
      </ul>
      <nav>
        <button disabled={state.page <= 1} onClick={() => nav.patch({ page: String(state.page - 1) })}>
          Prev
        </button>
        <span>{state.page} / {state.pageCount}</span>
        <button
          disabled={state.page >= state.pageCount}
          onClick={() => nav.patch({ page: String(state.page + 1) })}
        >
          Next
        </button>
      </nav>
    </main>
  ));
```

## Why replace-window is the right default

Replacing the window keeps `state.items` at one page (~20 rows), which fits
rpxd's whole-state snapshot model cleanly: write-through stays small and a
reconnect resync is one page, not the whole history. If you instead *accumulate*
rows as the user pages, see the caveat in
[Infinite scroll](/rpxd-live/guides/infinite-scroll/).

:::note
`keyOf` keeps React keys stable across a page's rows even when an optimistic
insert's temp id is later replaced by a server id — see
[Optimistic updates](/rpxd-live/guides/optimistic-updates/).
:::
