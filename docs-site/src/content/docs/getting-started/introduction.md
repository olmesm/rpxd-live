---
title: Introduction
description: What rpxd is, the mental model behind live objects, and how the pieces fit together.
sidebar:
  order: 1
---

rpxd is a **live-object framework for React**. Instead of a REST/RPC layer plus
client state management plus a cache plus optimistic-update plumbing, you write
one **live object** per page: a server-side, per-session stateful object with a
`mount`, some reducers, and a `render`.

Everything else — streaming state to the browser, applying the minimal diff,
replaying optimistic updates, reconnecting, multiplayer — is handled by the
framework.

## The mental model

A live object has three parts, expressed as one fluent chain:

```tsx
export default live("/counter")
  // 1. mount — runs on the server, returns the initial state
  .mount(async (_params, ctx) => ({ count: 0 }))
  // 2. rpc — a reducer; runs on the server, mutates state through ctx.patchState
  .rpc("inc", (r) =>
    r.handler(async (_payload, ctx) => {
      ctx.patchState((s) => {
        s.count += 1;
      });
    }),
  )
  // 3. render — plain React, fed fully-typed props
  .render(({ state, rpc }) => (
    <button type="button" onClick={() => rpc.inc()}>
      count: {state.count}
    </button>
  ));
```

- **`mount`** runs server-side and returns the initial state. Its shape *locks*
  the state type for everything downstream.
- **`rpc`s** are reducers. They run on the server as plain async functions; all
  state writes go through `ctx.patchState(mutator)`. rpxd diffs the mutation
  with [Immer](https://immerjs.github.io/immer/) and streams the **minimal
  patch** to the browser.
- **`render`** is ordinary React. It receives typed props — `state`, an
  exact-keyed `rpc` facade, `sync` status, `nav`, `keyOf` — and never has to
  know a request happened.

## What makes it different

- **One fluent chain, zero annotations.** State locks at `.mount()`, payloads
  lock at each `.rpc()`, and `.render()` receives props typed from all of it —
  including a `rpc` facade where unknown names and wrong payloads are *compile*
  errors. No codegen, no generated client.
- **Patches, not payloads.** The wire carries Immer patches with sequence
  numbers, not whole responses. A token stream growing a string
  (`s.answer += delta`) compiles to an `append` op that carries only the delta.
- **Optimistic by replay.** The client keeps confirmed server state plus a
  queue of your optimistic functions, and derives the view by replaying them.
  Acks apply the real patch and drop the function; errors just drop it — free
  rollback, no merge logic.
- **Multiplayer via pubsub.** Instances are per-session; `ctx.subscribe` /
  `ctx.broadcast` coordinate them. Any node can host any session.
- **The framework never touches your database.** Data access lives in your own
  `domain/` modules (see [App structure](/rpxd-live/guides/domain-layer/)).

## Where to go next

- [Installation](/rpxd-live/getting-started/installation/) — set up a project.
- [Your first live object](/rpxd-live/getting-started/first-live-object/) — build
  one end to end.
- [The fluent chain](/rpxd-live/guides/the-fluent-chain/) — the full
  `live().mount().rpc().render()` surface.

:::note
The normative specification lives in
[`spec.md`](https://github.com/olmesm/rpxd-live/blob/main/spec.md) and the wire
protocol in [Wire protocol](/rpxd-live/concepts/wire-protocol/).
These docs are the friendly version; the spec is the source of truth.
:::
