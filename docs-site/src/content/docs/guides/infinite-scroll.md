---
title: Infinite scroll
description: Accumulate windows with the params loader — cursor in the URL, an IntersectionObserver sentinel, and the honest snapshot-retention caveat.
sidebar:
  order: 10
---

Infinite scroll is [pagination](/rpxd-live/guides/pagination/) that **appends**
instead of replacing. The loader checks whether a `cursor` is present: absent →
first window (replace), present → next window (append). A sentinel element at the
bottom of the list triggers the next `nav.patch({ cursor })` as it scrolls into
view.

```tsx
export default live("/feed")
  .mount(async () => ({ items: [] as Post[], cursor: null as string | null, hasMore: false, loading: true }))
  .params(async ({ cursor }, ctx) => {
    const append = cursor != null;
    ctx.patchState((s) => { s.loading = true; });
    const { items, nextCursor } = await listPosts(scopeFrom(ctx.session), {
      cursor: cursor ?? null, limit: 20, signal: ctx.signal,
    });
    ctx.patchState((s) => {
      s.items = append ? [...s.items, ...items] : items;   // append vs replace
      s.cursor = nextCursor;
      s.hasMore = nextCursor != null;
      s.loading = false;
    });
  }, { blockSsr: true })
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

Append emits compact `add` patches for the new tail — O(new rows) on the wire,
not O(total).

:::caution[Accumulated lists and snapshots]
Appending means `state.items` grows with every window — and rpxd persists
**whole-state** snapshots (§9). So the accumulated feed is written through on
every flush and pushed in full on a reconnect resync, both O(total). And on a
cold wake the instance re-runs `mount` and rebuilds from the URL's cursor, which
means the *first* window — a deep-scrolled position isn't restored.

Prefer **replace-window** [pagination](/rpxd-live/guides/pagination/) unless the
feed genuinely needs to accumulate. If it does:

- **Cap what you retain** — keep a sliding window (e.g. the last N pages) and drop
  the top as you append, so state and snapshots stay bounded.
- **Accept that reconnect/cold-wake rebuilds from the URL**, not from the
  accumulated list. Put the scroll anchor (a cursor) in the URL if you need to
  restore position, and rebuild forward from it.
:::
