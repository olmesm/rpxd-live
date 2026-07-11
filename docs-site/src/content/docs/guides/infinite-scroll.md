---
title: Infinite scroll
description: Accumulate windows with the `load` loader — cursor in the URL, an IntersectionObserver sentinel, and the honest snapshot-retention caveat.
sidebar:
  order: 6
---

Infinite scroll is [pagination](/rpxd-live/guides/pagination/) that **appends**
instead of replacing. The loader checks whether a `cursor` is present: absent →
first window (replace), present → next window (append). A sentinel element at the
bottom of the list triggers the next `nav.patch({ cursor })` as it scrolls into
view.

```tsx
export default live("/feed")
  .setup(() => ({ items: [] as Post[], cursor: null as string | null, hasMore: false, loading: true }))
  .load(async ({ search }, ctx) => {
    const append = search.cursor != null;
    // Subsequent pages flip the spinner synchronously (instant feedback, then
    // streamed). The first page has no synchronous patch, so SSR waits for the
    // awaited data — the initial feed is crawlable.
    if (append) ctx.patchState((s) => { s.loading = true; });
    const { items, nextCursor } = await listPosts(scopeFrom(ctx.session), {
      cursor: search.cursor ?? null, limit: 20, signal: ctx.signal,
    });
    ctx.patchState((s) => {
      s.items = append ? [...s.items, ...items] : items;   // append vs replace
      s.cursor = nextCursor;
      s.hasMore = nextCursor != null;
      s.loading = false;
    });
  })
  .render(({ state, nav, keyOf }) => {
    const sentinel = useRef<HTMLDivElement>(null);
    useEffect(() => {
      const el = sentinel.current;
      if (!el || !state.hasMore) return;
      const io = new IntersectionObserver(([e]) => {
        if (e.isIntersecting && !state.loading) nav.patch({ cursor: state.cursor! });
      });
      io.observe(el);
      return () => io.disconnect();
    }, [state.hasMore, state.loading, state.cursor]);

    return (
      <main>
        <ul>{state.items.map((p) => <li key={keyOf(p.id)}>{p.body}</li>)}</ul>
        {state.hasMore && <div ref={sentinel} aria-hidden />}
        {state.loading && <span>Loading…</span>}
      </main>
    );
  });
```

Appending sends compact `add` patches carrying only the new tail — the message
size scales with the new rows, not the whole list.

:::caution[Accumulated lists and snapshots]
Appending means `state.items` grows with every window — and rpxd persists
**whole-state** [snapshots](/rpxd-live/concepts/persistence/). Every state
write persists the full accumulated feed, and a reconnect resends it in full.
Both costs grow with the total list, not the last page. And when an instance is
rebuilt from scratch (a cold wake), `setup` re-runs and `load` rebuilds from
the URL's cursor — that's the *first* window, so a deep-scrolled position isn't
restored.

Prefer **replace-window** [pagination](/rpxd-live/guides/pagination/) unless the
feed genuinely needs to accumulate. If it does:

- **Cap what you retain** — keep a sliding window (e.g. the last N pages) and drop
  the top as you append, so state and snapshots stay bounded.
- **Accept that reconnect/cold-wake rebuilds from the URL**, not from the
  accumulated list. Put the scroll anchor (a cursor) in the URL if you need to
  restore position, and rebuild forward from it.
:::
