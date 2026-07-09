---
title: App structure (the domain layer)
description: A convention for organising app logic — routes are the thin edge, domain/ is the service-layer core, and only domain/ touches the database.
sidebar:
  order: 5
---

rpxd's `routes/` is your web edge — one live object per page, `setup` / `load` /
handlers / `render`. It says nothing about where your business logic and data
access live. This is the convention we recommend for that other half: a
**service layer** of bounded modules that own all real work.

It is a **convention only** — no runtime, no codegen, no framework awareness.
The framework never touches your database (spec §14); this is purely how you
organise userland modules. Adopt it, adapt it, or ignore it.

## The layers

- **`routes/`** — the edge: live objects (`render`), thin orchestration.
- **`domain/`** — the core: bounded modules that are the public API for your app
  logic.
- **`adapters/`** — server-only clients behind the domain: your database client
  (Prisma / Drizzle / …), the auth library.
- Multiplayer fan-out is `ctx.subscribe` / `broadcast` / `.on`, not a separate
  bus you wire up.

```
routes/          # the edge — live objects (thin orchestration)
domain/          # app logic — bounded modules (the public API)
  scope.ts       #   who is acting (Scope) — client-safe, no db
  todos.ts       #   listTodos / addTodo / toggleTodo
adapters/        # server-only clients behind the domain
  db.ts          #   the database client (a singleton)
  auth.ts        #   the auth library
```

`examples/kitchen-sink` is laid out this way — read it alongside this doc. API
routes (webhooks, auth) and how an auth library wires into `authenticate` are
covered in [Routes & auth](/rpxd-live/guides/routes-and-auth/).

## The one rule

> **Routes never import `db` directly. They call `domain/` functions.
> Only `domain/` imports `db`.**

This is the whole convention; the folders just file it somewhere. Keeping the web
layer off the database directly buys you:

- **Thin edge, fat core.** The handler validates (`input`), calls a domain fn,
  then `patchState` / `broadcast`. All real work — queries, invariants, joins —
  lives in `domain/`. (This is spec §6's "chatty client = missing reducer"
  pushed one layer deeper.)
- **Swappable persistence.** Swap the client in `adapters/db.ts` (the example
  uses Prisma/SQLite) and nothing under `routes/` changes.
- **Tests without the harness.** The pure parts (e.g. `scopeFrom`) unit-test
  with no `live()`, ctx, or db (see
  `examples/kitchen-sink/test-bun/scope.test.ts`); the DB-backed queries are
  integration-tested end to end by the Playwright suite. Mock at the domain
  boundary — coarse and stable — instead of reaching for a db handle on `ctx`.
  ([Testing](/rpxd-live/guides/testing/) covers the `testLive` harness and the
  test tiers.)
- **Transactions land where they belong.** A DB transaction opens and closes
  *inside* a domain function. Keeping the db off `ctx` (spec §10) follows from
  this: a transaction that lived on `ctx` would span a handler's awaits, and
  since awaits don't block the instance (§3) it would hold a connection open
  across unrelated rpcs.

```tsx
// routes/index.tsx — the edge
import { addTodo, listTodos, type TodoRow } from "../domain/todos";
import { scopeFrom } from "../domain/scope";

export default live("/")
  .setup(() => ({ todos: [] as TodoRow[] })) // sync skeleton, no IO
  .load(async (_url, ctx) => {
    const todos = await listTodos(scopeFrom(ctx.session)); // the loader fetches
    ctx.patchState((s) => {
      s.todos = todos;
    });
  })
  .rpc("add", (r) =>
    r.handler(async ({ text }, ctx) => {
      const todo = await addTodo(scopeFrom(ctx.session), text); // logic lives in domain/
      ctx.patchState((s) => {
        s.todos.push(todo);
      });
    }),
  );
```

```ts
// domain/todos.ts — the core (only this layer touches the db). In the RSC
// example the client is loaded lazily + server-only so it never enters the
// client bundle (see Routes & auth); shown direct here for brevity.
import { db } from "../adapters/db"; // the Prisma client

export async function listTodos(scope: Scope) {
  const owner = scope.user?.id ?? scope.sid;
  return db.todo.findMany({ where: { owner }, orderBy: { created: "asc" } });
}
```

## Scope — who is acting

The domain layer needs to know *whose* data it's touching. Model that as a
**`Scope`**: a small struct carrying the actor/tenant, threaded as the **first
argument** to every domain function.

`authenticate` receives the framework's resolved session id — the same identity
used for instance routing and storage — so it can return a scope keyed to it:

```ts
// rpxd.config.ts
session: { authenticate: (_req, { sid }) => ({ sid }) },
```

Routes derive the scope from `ctx.session` (`scopeFrom`) and pass it down;
domain functions scope their queries by it (`db.todo.findMany({ where: { owner
} })` — spec §1's `findMany({ where: { orgId } })`). A bare `sid` today extends
to `{ user, org }` tomorrow without rewriting every signature. Keeping this a
plain value passed *into* domain functions — rather than the db on `ctx` — is why
two sessions never see each other's todos from one shared database.

## Naming

Don't call the directory `contexts/` — rpxd already uses "context" for the
handler `ctx` (`SetupCtx`, `RpcCtx`, `HandlerCtx`), and `lib/` is conventionally
shared UI. `domain/` is collision-free and names the thing honestly; `app/` is
the other reasonable choice.

## Enforcing the boundary

The convention is enforced by discipline; if you want it harder, two options
your app can adopt:

- **Lint** — a Biome rule forbidding a `db` import under `routes/` (a natural
  sibling to spec §4's identity-lookup rule). The enforceable form of the
  discipline.
- **Package boundary** — `domain/` as a workspace package with `db` as its
  private dependency. Hard enforcement, but overkill until the app is large.

TypeScript won't stop a route from reaching into `domain/todos/queries.ts`. Keep
the public surface a single barrel (`domain/todos.ts`) and treat deep imports as
what a lint rule would forbid — otherwise the boundary erodes.
