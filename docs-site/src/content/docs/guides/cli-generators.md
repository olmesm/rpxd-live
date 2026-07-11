---
title: CLI generators
description: Scaffold apps and resources with rpxd init, rpxd auth, and rpxd scaffold — file generators that write code and print the rest, never patching your hand-owned files.
sidebar:
  order: 11
---

The `rpxd` CLI can scaffold a new app, a working page, and auth wiring — one
command each: `init`, `scaffold`, and `auth`, shipped alongside
`dev`/`build`/`start`.

All three are **file scaffolders** with the same guarantees. They write new
files, and they _print_ anything that touches a file you own (`rpxd.config.ts`,
`package.json`) rather than patching it. They never overwrite an existing file
unless you pass `--force`. The one exception is `prisma/schema.prisma`: when
your app has a database, generators **append** models to it directly —
append-only, so existing models are never rewritten.

## Write one by hand first

You don't need a generator to build an rpxd app.
[Your first live object](/rpxd-live/getting-started/first-live-object/) is a
route you write by hand — that's the whole primitive, and it's worth doing once
so the generated code reads as familiar rather than magic.

`rpxd scaffold` writes exactly that shape for you: the same `live()` route, a
scoped domain module, a test. It's a **starting point you own** — edit the
output like any other file; nothing regenerates it. Reach for a hand-written
route when the page is bespoke, and for `scaffold` when it's the common
resource-shaped page (a list with create/toggle/remove). Both produce the same
kind of code; the generator just skips the typing.

## `rpxd init` — a new app

```sh
bunx @rpxd/cli init my-app        # auth + Prisma/SQLite by default
cd my-app && bun install && bun run setup && bun run dev
```

`init` scaffolds the documented app tree — `routes/`, `domain/`,
`adapters/`, `prisma/`, `rpxd.config.ts` — with a runnable welcome route so the
app boots immediately.

| Flag        | Effect                                                                 |
| ----------- | ---------------------------------------------------------------------- |
| _(default)_ | Better Auth + Prisma/SQLite, login + protected account pages           |
| `--no-auth` | Keep the database, drop auth (anonymous `sid` scoping)                 |
| `--no-db`   | Memory storage, no Prisma — implies `--no-auth` (Better Auth needs db) |
| `--force`   | Scaffold into a non-empty directory                                    |

## `rpxd scaffold` — a resource

A context (the domain module grouping), a schema, a plural route segment, and
`field:type` pairs.

```sh
rpxd scaffold Todos Todo todos text:string done:boolean
```

The **plural** becomes the route path (`/todos`) and table. It's only
normalized for casing — `Blog Posts` resolves to a clean segment
(`blogPosts`) — and otherwise taken verbatim, so irregular plurals just work:
`rpxd scaffold People Person people` scaffolds `/people`, never `/peoples`.

This writes a live route (`routes/todos.tsx`), a scoped domain module
(`domain/todos.ts`), and a test (`test/todos.test.ts` — a `testLive` route test
that drives the real live object). The generator is **auth- and db-aware**: it
reads whether your app has `adapters/db.ts` / `adapters/auth.ts` and generates a
Prisma-backed or in-memory domain, scoped by the acting user or session
accordingly. When your app has a database, the Prisma model is **appended** to
`prisma/schema.prisma` (append-only — it never rewrites your existing models,
and re-running is a no-op).

Field names are normalized to camelCase (`author_id` → `authorId`). Field types
map to TypeScript and Prisma:

| `type`     | TypeScript | Prisma     |
| ---------- | ---------- | ---------- |
| `string`   | `string`   | `String`   |
| `text`     | `string`   | `String`   |
| `boolean`  | `boolean`  | `Boolean`  |
| `int`      | `number`   | `Int`      |
| `float`    | `number`   | `Float`    |
| `datetime` / `date` | `Date` | `DateTime` |
| `json`     | `unknown`  | `Json`     |
| `references` | (foreign key `string`) | `String` + `@relation` |

| Flag             | Effect                                                          |
| ---------------- | -------------------------------------------------------------- |
| `--kind http`    | Emit a `route()` endpoint (`routes/api.<plural>.ts`, served at `/api/<plural>`) instead of a page |
| `--no-protected` | Make the page public (see below)                               |
| `--protected`    | Force the guard → `/login` gate (auth apps only)               |
| `--no-test`      | Skip the test                                                  |
| `--force`        | Overwrite existing files                                       |

**Auth apps protect pages by default.** When the app has auth, a scaffolded
page's `guard` redirects to `/login` when signed out, and the generated test
signs in so it still passes. Pass `--no-protected` for a public page. Without
auth, pages are public — there's no login route to bounce to — and
`--protected` is ignored with a note. An `http` route has no `guard` gate, so
protection never applies to it. One exception: the auth-generated account page.
Its state *is* the signed-in user, so its redirect lives in `setup` rather than
`guard`.

### Relationships

A `references` field declares a **foreign-key relation**,
`foreign_key:references:Model`:

```sh
rpxd scaffold Posts Post posts title:string author_id:references:User
```

The appended `Post` model gains the foreign key, the relation, and an index:

```prisma
model Post {
  id       String @id @default(cuid())
  owner    String
  title    String
  authorId String
  author   User   @relation(fields: [authorId], references: [id])
  created  DateTime @default(now())

  @@index([owner])
  @@index([authorId])
}
```

Then run the printed steps — **`prisma format`** inserts the inverse
`posts Post[]` field on `User` for you, and `bun run db:push` (or
`prisma migrate dev`) syncs the database. The scaffold only writes the
foreign-key side and scopes the resource by `owner`; whether it should instead be
reached through its parent is a decision it leaves to you.

## `rpxd auth` — add auth later

```sh
rpxd auth
```

Layers Better Auth + Prisma onto an existing app: it writes `adapters/auth.ts`,
the login + account pages, and the `/api/auth/*` delegation route (and the
Prisma data layer if you don't have one yet). It **prints** the
`session.authenticate` hook to add to `rpxd.config.ts`, the dependencies to
install, and — if you already have a `adapters/db.ts` — the `authAdapter` export
and Better Auth models to add by hand. Auth config is Better Auth's own, in
`adapters/auth.ts`; rpxd doesn't wrap it.
