---
title: Optimistic updates
description: The replay model — confirmed server state plus a queue of pure optimistic functions — and how temp ids link to real ids without remounting.
sidebar:
  order: 3
---

This page shows how to make an rpc feel instant: apply the change on the
client immediately, then let the server confirm it. rpxd's model for this is
**function replay**, not patch merging. The client keeps two things:

- **`confirmed`** — the last server truth.
- **a pending queue** of your optimistic functions.

The view the user sees is `replay(pending, confirmed)`. This makes rollback
free and merges impossible to get wrong.

## The lifecycle

1. You call `rpc.add({ text })`. The optimistic function is pushed to the queue
   and the view re-derives instantly.
2. The batch is POSTed. When the **ack** (the server's acknowledgment of the
   rpc) arrives, its patch is applied to `confirmed` and the function is
   dropped from the queue — the optimistic and real states converge with no
   visible flip.
3. If the rpc **errors**, the function is simply dropped: the view snaps back to
   `confirmed`. Free rollback.
4. If a replay ever **throws** (e.g. it referenced a row that no longer exists),
   it's dropped silently.

## Writing optimistic functions

Optimistic functions must be **synchronous, pure, and identity-based**:

```tsx
.optimistic((s, { text }, ctx) => {
  s.todos.push({ id: ctx.tempId(), text, done: false }); // create → tempId
})
```

- **Identity-based lookups.** Use `find(t => t.id === id)`, never an index —
  the queue may have reordered things. (This convention isn't enforced by
  tooling yet; it's documented here and in TSDoc.)
- **Creates use `ctx.tempId()`** as a placeholder id.

## Id linking without remounting

When a create is confirmed, the real id must replace the temp id — but you don't
want the row to remount and lose focus or animation. rpxd handles this: the
runtime matches your optimistic temp id to the real id the server confirms, and
**`keyOf(id)`** applies that mapping at render time. It returns the original
temp id for optimistically-created rows and the id unchanged otherwise — stable
React keys, no remount. (The matching mechanics are described in the
[wire protocol](/rpxd-live/concepts/wire-protocol/) page.)

```tsx
{state.todos.map((t) => (
  <li key={keyOf(t.id)}>{t.text}</li>
))}
```

For shapes the matcher can't infer, `ctx.resolveId()` is the escape hatch. Id
linking is entirely client-side; nothing the server sends is rewritten.

## Testing

Optimistic replay is client-side, so exercise the full round trip
(instant render → server id without remount) end to end with Playwright. Use the
[`testLive`](/rpxd-live/guides/testing/) harness to pin the **server contract**
the optimism mirrors — the handler's patches and the id the ack resolves.
