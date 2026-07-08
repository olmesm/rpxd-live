# Domain layer — organising app logic (convention)

rpxd's `routes/` is your web edge — the Phoenix `app_web` equivalent: one live
object per page, `mount`/handlers/`render`. It says nothing about where your
business logic and data access live. This is the convention we recommend for
that other half, modelled on **Phoenix contexts**.

It is a **convention only** — no runtime, no codegen, no framework awareness.
The framework never touches your database (spec §14); this is purely how you
organise userland modules. Adopt it, adapt it, or ignore it.

## The layers

| Phoenix                         | rpxd                                    |
| ------------------------------- | --------------------------------------- |
| `my_app_web/` (router, LiveViews) | `routes/` — live objects + `render`   |
| `my_app/` contexts (`Accounts`) | `domain/` — bounded modules             |
| `MyApp.Repo`                    | `adapters/db.ts` — your client (Prisma/Drizzle/…) |
| `Phoenix.PubSub`                | `ctx.subscribe` / `broadcast` / `.on`   |

```
routes/          # the edge — live objects (thin orchestration)
domain/          # app logic — bounded modules (the public API)
  scope.ts       #   who is acting (Scope) — client-safe, no db
  todos.ts       #   listTodos / addTodo / toggleTodo
adapters/        # server-only clients behind the domain
  db.ts          #   the database client (a singleton)
  auth.ts        #   the auth library (see routes-and-auth.md)
```

`examples/todos` is laid out this way — read it alongside this doc. API routes
(webhooks, auth) and how an auth library wires into `authenticate` are covered
in [`routes-and-auth.md`](./routes-and-auth.md).

## The one rule

> **Routes never import `db` directly. They call `domain/` functions.
> Only `domain/` imports `db`.**

This is the whole convention; the folders just file it somewhere. It's the same
discipline Phoenix enforces with "the web layer never touches `Repo`", and it
buys the same things:

- **Thin edge, fat core.** The handler validates (`input`), calls a domain fn,
  then `patchState`/`broadcast`. All real work — queries, invariants, joins —
  lives in `domain/`. (This is spec §6's "chatty client = missing reducer"
  pushed one layer deeper.)
- **Swappable persistence.** Swap the client in `adapters/db.ts` (the example
  uses Prisma/SQLite) and nothing under `routes/` changes.
- **Tests without the harness.** The pure parts (e.g. `scopeFrom`) unit-test
  with no `live()`, ctx, or db (see `examples/todos/test-bun/scope.test.ts`);
  the DB-backed queries are integration-tested end-to-end by the Playwright
  suite. Mock at the domain boundary — coarse and stable — instead of reaching
  for a db handle on `ctx`.
- **Transactions land where they belong.** A DB transaction opens and closes
  *inside* a domain function, exactly like `Repo.transaction` inside a Phoenix
  context. Keeping the db off `ctx` (spec §10) follows from this: a transaction
  that lived on `ctx` would span a handler's awaits, and since awaits don't
  block the instance (§3) it would hold a connection open across unrelated rpcs.

```tsx
// routes/index.tsx — the edge
import { addTodo, listTodos } from "../domain/todos";
import { scopeFrom } from "../domain/scope";

export default live("/")
  .mount(async (_params, ctx) => ({ todos: await listTodos(scopeFrom(ctx.session)) }))
  .rpc("add", (r) =>
    r.handler(async ({ text }, ctx) => {
      const todo = await addTodo(scopeFrom(ctx.session), text); // logic lives in domain/
      ctx.patchState((s) => { s.todos.push(todo); });
    }),
  );
```

```ts
// domain/todos.ts — the core (only this layer touches the db). In the RSC
// example the client is loaded lazily + server-only so it never enters the
// client bundle (see routes-and-auth.md); shown direct here for brevity.
import { db } from "../adapters/db"; // the Prisma client

export async function listTodos(scope: Scope) {
  const owner = scope.user?.id ?? scope.sid;
  return db.todo.findMany({ where: { owner }, orderBy: { created: "asc" } });
}
```

## Scope — who is acting

The domain layer needs to know *whose* data it's touching. Model that the way
Phoenix 1.8 does — a **`Scope`**: a small struct carrying the actor/tenant,
threaded as the **first argument** to every domain function.

| Phoenix                         | rpxd                                        |
| ------------------------------- | ------------------------------------------- |
| `fetch_current_scope` plug      | `session.authenticate(req, { sid })` config |
| `socket.assigns.current_scope`  | `ctx.session`                               |
| `Projects.list(scope)`          | `listTodos(scope)`                          |

`authenticate` receives the framework's resolved session id — the same identity
used for instance routing and storage — so it can return a scope keyed to it:

```ts
// rpxd.config.ts
session: { authenticate: (_req, { sid }) => ({ sid }) },
```

Routes derive the scope from `ctx.session` (`scopeFrom`) and pass it down;
domain functions scope their queries by it (`db.todo.findMany({ where: {
owner } })` — spec §1's `findMany({ where: { orgId } })`). A bare `sid` today
extends to `{ user, org }` tomorrow without rewriting every signature. Keeping
this a plain value passed *into* domain functions — rather than the db on
`ctx` — is why two sessions never see each other's todos from one shared
database.

## Naming

Don't call the directory `contexts/` — rpxd already uses "context" for the
handler `ctx` (`MountCtx`, `RpcCtx`, `HandlerCtx`), and `lib/` is conventionally
shared UI. `domain/` is collision-free and names the thing honestly; `app/` is
the other reasonable choice if you want the literal Phoenix homage.

## Enforcement gradient

Start at 1; move up only when an app earns it.

1. **Convention** — documented here, demonstrated in `examples/todos`. *(This
   is where we are.)*
2. **Lint** — a Biome rule forbidding a `db` import under `routes/` (a natural
   sibling to spec §4's identity-lookup rule). The enforceable form of the
   discipline.
3. **Package boundary** — `domain/` as a workspace package with `db` as its
   private dependency. Hard enforcement, but overkill until the app is large.

Unlike Elixir modules, TypeScript won't stop a route from reaching into
`domain/todos/queries.ts`. Keep the public surface a single barrel
(`domain/todos.ts`) and treat deep imports as what tier 2 eventually forbids —
otherwise the boundary erodes exactly where Phoenix's wouldn't.
