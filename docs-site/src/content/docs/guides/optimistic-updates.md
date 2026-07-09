---
title: Optimistic updates
description: The replay model — confirmed server state plus a queue of pure optimistic functions — and how temp ids link to real ids without remounting.
sidebar:
  order: 3
---

rpxd's optimistic model is **function replay**, not patch merging. The client
keeps two things:

- **`confirmed`** — the last server truth.
- **a pending queue** of your optimistic functions.

The view the user sees is `replay(pending, confirmed)`. This makes rollback
free and merges impossible to get wrong.

## The lifecycle

1. You call `rpc.add({ text })`. The optimistic function is pushed to the queue
   and the view re-derives instantly.
2. The batch is POSTed. When the **ack** arrives, its patch is applied to
   `confirmed` and the function is dropped from the queue — the optimistic and
   real states converge with no visible flip.
3. If the rpc **errors**, the function is simply dropped: the view snaps back to
   `confirmed`. Free rollback.
4. If a replay ever **throws** (e.g. it referenced a row that no longer exists),
   it's dropped silently.

## Writing optimistic functions

Optimistic functions must be **synchronous, pure, and identity-based**:

```tsx
.optimistic((s, { text }, ctx) => {
  s.todos.push({ id: ctx.tempId, text, done: false }); // create → tempId
})
```

- **Identity-based lookups.** Use `find(t => t.id === id)`, never an index —
  the queue may have reordered things. (This convention isn't enforced by
  tooling yet; it's documented here and in TSDoc.)
- **Creates use `ctx.tempId`** as a placeholder id.

## Id linking without remounting

When a create is confirmed, the real id must replace the temp id — but you don't
want the row to remount and lose focus/animation. rpxd handles this:

- The runtime records **where `tempId` lands** in the optimistic patches (path +
  sub-path — any field name, nested is fine).
- It matches the corresponding `add` op in the ack patches and reads the same
  sub-path, producing `idMap: { tempId → realId }`.
- **`keyOf(id)`** applies that map at render time: it returns the original
  tempId for optimistically-created rows and the id unchanged otherwise — stable
  React keys, no remount, no wire rewriting.

```tsx
{state.todos.map((t) => (
  <li key={keyOf(t.id)}>{t.text}</li>
))}
```

For shapes the position-matcher can't infer, `ctx.resolveId()` is the escape
hatch. Id linking is entirely client-side; the wire is never rewritten.

## Testing

Optimistic replay is client-side, so exercise the full round trip
(instant render → server id without remount) end to end with Playwright. Use the
[`testLive`](/rpxd-live/guides/testing/) harness to pin the **server contract**
the optimism mirrors — the handler's patches and the id the ack resolves.
