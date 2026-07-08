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
[Routes & auth](/guides/routes-and-auth/)).

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
(`domain/todos.ts`), and a test (`domain/todos.test.ts`). The generator is
**auth- and db-aware**: it reads whether your app has `adapters/db.ts` /
`adapters/auth.ts` and generates a Prisma-backed or in-memory domain, scoped by
the acting user or session accordingly. When your app has a database, the Prisma
model is _printed_ for you to paste into `prisma/schema.prisma`.

Field types map to TypeScript and Prisma: `string`/`text` → `String`,
`boolean` → `Boolean`, `int` → `Int`, `float` → `Float`, `datetime` →
`DateTime`.

| Flag          | Effect                                                          |
| ------------- | -------------------------------------------------------------- |
| `--kind http` | Emit a `route()` endpoint (`routes/<plural>.ts`) instead of a page |
| `--protected` | Gate the page behind the mount → `/login` redirect (auth apps)  |
| `--no-test`   | Skip the domain test                                            |
| `--force`     | Overwrite existing files                                        |

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
