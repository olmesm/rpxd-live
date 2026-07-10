---
title: Your first live object
description: Build a todo list as a live object, step by step — setup, load, an rpc with validation, optimistic updates, and render.
sidebar:
  order: 3
---

Let's build a small todo list as a live object. We'll add state, a reducer with
input validation, an optimistic update, and a typed render — the whole loop.

## 1. State from `setup` + `load`

`setup` runs on the server and returns the initial state **synchronously** — its
return shape locks the state type for the rest of the chain. Data loading is IO,
so it lives in `load`, which runs after `setup` (and on every URL change) and
writes page state through `ctx.patchState`.

```tsx
// routes/index.tsx
import { live } from "@rpxd/core";
import { listTodos, type Todo } from "../domain/todos";
import { scopeFrom } from "../domain/scope";

export default live("/")
  .setup(() => ({ todos: [] as Todo[] }))
  .load(async (_url, ctx) => {
    const todos = await listTodos(scopeFrom(ctx.session));
    ctx.patchState((s) => { s.todos = todos; });
  });
```

The loader calls a `domain/` function rather than touching the database
directly — routes are the thin edge, `domain/` is the core (see
[App structure](/rpxd-live/guides/domain-layer/)).

## 2. A reducer with validation

`.rpc(name, r => ...)` defines a reducer. `.input(schema)` validates the payload
(client-side before the optimistic update *and* server-side) and locks the
payload type for every later step.

```tsx
import { z } from "zod";

  // ...continuing the chain
  .rpc("add", (r) =>
    r
      .input(z.object({ text: z.string().min(1) }))
      .handler(async ({ text }, ctx) => {
        const todo = await addTodo(scopeFrom(ctx.session), text);
        ctx.patchState((s) => {
          s.todos.push(todo);
        });
      }),
  );
```

All state writes go through `ctx.patchState(mutator)`. The mutator is a **sync**
Immer function on a fresh draft; rpxd produces the exact patch and streams it.
`await`s never block the instance — other rpcs run concurrently while this one
waits on the database.

## 3. Make it optimistic

Add an `.optimistic()` function and the UI updates instantly, before the server
answers. It's a pure, synchronous mutation replayed over confirmed state; the
ack reconciles it and `ctx.tempId()` bridges the client-generated id to the real
one.

```tsx
  .rpc("add", (r) =>
    r
      .input(z.object({ text: z.string().min(1) }))
      .optimistic((s, { text }, ctx) => {
        s.todos.push({ id: ctx.tempId(), text, done: false });
      })
      .handler(async ({ text }, ctx) => {
        const todo = await addTodo(scopeFrom(ctx.session), text);
        ctx.patchState((s) => {
          s.todos.push(todo);
        });
      }),
  );
```

Read the details in [Optimistic updates](/rpxd-live/guides/optimistic-updates/).

## 4. Render — plain React, fully typed

`.render()` receives typed props. `rpc.add` is exact-keyed — a wrong name or the
wrong payload is a compile error. `keyOf` returns stable React keys across the
optimistic-to-confirmed transition.

```tsx
  .render(({ state, rpc, sync, keyOf }) => (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        const input = e.currentTarget.elements.namedItem("text") as HTMLInputElement;
        rpc.add({ text: input.value });
        input.value = "";
      }}
    >
      <ul>
        {state.todos.map((t) => (
          <li key={keyOf(t.id)}>{t.text}</li>
        ))}
      </ul>
      <input name="text" />
      <button type="submit" disabled={sync.pending}>
        Add
      </button>
    </form>
  ));
```

That's a complete live object: server state, a validated + optimistic reducer,
and a typed render — no API layer, no client store, no manual cache.

## What just happened

- **On load**, the server ran `listTodos` and streamed the todos into the
  snapshot after the sync `setup` skeleton; the page is server-rendered and
  crawlable.
- **On `rpc.add`**, the client applied your optimistic function immediately,
  POSTed a batch, and the server ran the handler. The resulting Immer patch
  streamed back as an ack; the client swapped the temp id for the real one via
  `keyOf` without remounting the row.
- **If the handler had thrown**, the optimistic function would simply be
  dropped — a free rollback — and `sync.errors` would be populated.

Next, dig into the [full fluent chain](/rpxd-live/guides/the-fluent-chain/) —
or, now that you've seen the shape by hand, let
[`rpxd scaffold`](/rpxd-live/guides/cli-generators/) write it for you.
