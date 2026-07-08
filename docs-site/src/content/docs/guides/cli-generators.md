---
title: CLI generators
description: Scaffold apps and resources with rpxd init, rpxd auth, and rpxd scaffold — file generators that write code and print the rest, never patching your hand-owned files.
sidebar:
  order: 7
---

The `rpxd` CLI ships three generators alongside `dev`/`build`/`start`. They are
**file scaffolders**: they write files and _print_ anything that touches a file
you own (`rpxd.config.ts`, `package.json`, `prisma/schema.prisma`). They never
patch those in place, and they never overwrite an existing file unless you pass
`--force` — the framework maintains the mirror, not the logic (see
[Routes & auth](/rpxd-live/guides/routes-and-auth/)).

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

`init` scaffolds the documented userland tree — `routes/`, `domain/`,
`adapters/`, `prisma/`, `rpxd.config.ts` — with a runnable welcome route so the
app boots immediately.

| Flag        | Effect                                                                 |
| ----------- | ---------------------------------------------------------------------- |
| _(default)_ | Better Auth + Prisma/SQLite, login + protected account pages           |
| `--no-auth` | Keep the database, drop auth (anonymous `sid` scoping)                 |
| `--no-db`   | Memory storage, no Prisma — implies `--no-auth` (Better Auth needs db) |
| `--force`   | Scaffold into a non-empty directory                                    |

## `rpxd scaffold` — a resource

Phoenix-style: a context, a schema, a plural, and `field:type` pairs.

```sh
rpxd scaffold Todos Todo todos text:string done:boolean
```

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

| Flag          | Effect                                                          |
| ------------- | -------------------------------------------------------------- |
| `--kind http` | Emit a `route()` endpoint (`routes/<plural>.ts`) instead of a page |
| `--protected` | Gate the page behind the mount → `/login` redirect (auth apps)  |
| `--no-test`   | Skip the test                                                   |
| `--force`     | Overwrite existing files                                        |

### Relationships

A `references` field is a **belongs_to**, Phoenix-style
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
belongs_to side and scopes the resource by `owner`; whether it should instead be
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
