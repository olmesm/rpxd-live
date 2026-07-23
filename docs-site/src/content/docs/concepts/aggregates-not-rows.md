---
title: Aggregates, not rows
description: A live object owns an aggregate with its own lifecycle — not a single row. Reach for a slot when a thing has its own rpcs and multiplayer scope; keep collections inside one live object.
sidebar:
  order: 8
---

A live object owns an **aggregate** — a whole thing with its own behaviour — not
a single row in a list. This page is the rule for deciding when to reach for a
[live slot](/rpxd-live/guides/live-slots-and-layouts/) (`<LiveSlot>`) and when to keep data
inside one live object.

The short version: give a thing its own live object when it has its own
**lifecycle** — its own rpcs, its own subscriptions, its own multiplayer scope.
Do not give one to every item in a collection.

## The smell test

If you are calling `.map()` to render `<LiveSlot>`s, stop.

```tsx
// ✗ one live object per row — the antipattern
{comments.map((c) => (
  <LiveSlot key={c.id} of={Comment} params={{ id: c.id }} />
))}
```

A list of slots is a missing aggregate. The comments want to be **one** live
object that owns the collection — its state is the array, its rpcs add and edit
entries, and it broadcasts changes to everyone viewing it.

```tsx
// ✓ one live object owns the collection
<LiveSlot of={CommentThread} params={{ postId }} />
```

## Why the collection wants to be one object

Every live object is a real server instance. It costs memory, it holds a
snapshot, and it joins the broadcast bus. A hundred tiny instances is a hundred
of each. That cost is invisible to a byte budget — the instances are small — so
rpxd counts them instead.

- Each session is capped at a small number of live objects. The default is
  deliberately tight, so the list-of-slots shape fails fast while you are still
  developing. Past the cap, new mounts are refused and the slot renders its
  fallback; the refusal carries a diagnostic that points back here.
- Well before the cap, mounting many sibling slots at once logs a
  `slot-fanout-high` diagnostic in development. It is an early warning, not an
  error: a page that fans out ten slots in one go is usually a collection that
  should have been one object.

Both diagnostics name this page. If you see either, the fix is almost always to
fold the collection into a single aggregate.

## Coordination goes through the server

Slots do not share optimistic state. Pending changes, temporary ids, and id
linking are per object — there is no cross-object optimism, by design. When one
live object needs to tell another that something changed, use the
[broadcast bus](/rpxd-live/concepts/pubsub/): broadcast an event, handle it in
the other object's `on` handler. State-bearing coordination goes through the
server, which keeps it correct for every session at once. View-only coordination
(a highlight, a hover) stays in plain React.

This is the sibling of another rpxd rule: a chatty client is a missing reducer,
and a list of slots is a missing aggregate. Both push you toward fewer, richer
live objects.

## The dashboard, worked through

The kitchen-sink dashboard shows both sides of the rule on one screen.

**Chat is a slot — the positive case.** The chat panel has its own lifecycle: a
bus topic per channel, its own send and agent rpcs, its own multiplayer scope.
It lives in the layout, so it survives every navigation. That independent
lifecycle is exactly what earns a live object.

**The messages inside chat are not slots — the negative case.** The message list
is plain `state.messages` on that one chat object. Each message is a row, not an
aggregate: it has no rpcs of its own and no one subscribes to a single message.
One live object owns the whole list.

So the test is not "is this thing important enough?" — it is "does this thing
have its own lifecycle?" A channel does. A message does not.

## When you are tempted

| You have | Reach for | Not |
| --- | --- | --- |
| A chat panel that outlives the page | A slot in the layout | — |
| A list of comments | One `CommentThread` object owning the array | A slot per comment |
| A cart with many line items | One `Cart` object owning the items | A slot per item |
| A live document with sections | One `Document` object owning the sections | A slot per section |
| A second widget with its own rpcs and audience | Its own slot | Folding it into the page |

The dividing line is the same every time: lifecycle earns an object; data lives
inside one.
