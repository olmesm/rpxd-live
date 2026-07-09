---
title: Installation
description: Set up an rpxd project, run the dev server, and understand the project layout.
sidebar:
  order: 2
---

rpxd develops and runs primarily on [Bun](https://bun.sh): `rpxd dev` and
`rpxd build` run Vite on Bun, and the default runtime is `Bun.serve` (HTTP + WS
on one port) with `bun:sqlite`.

A **Node ≥ 24** runtime is also shipping. `@rpxd/adapter-node` mirrors the Bun
adapter over `node:http` + `ws`, `@rpxd/storage-sqlite/node` swaps `bun:sqlite`
for `better-sqlite3`, and `rpxd start` selects the Node adapter automatically
when it isn't running under Bun. One caveat before it's turnkey: Node's ESM
resolver needs explicit file extensions, so an app deployed on Node must use
extensionful relative imports (`./adapters/auth.ts`) in `rpxd.config.ts` and
anything it pulls in — Bun resolves those without extensions, Node does not.

## Try the example

The fastest way to see rpxd is the `kitchen-sink` example in the repo:

```sh
git clone https://github.com/olmesm/rpxd-live
cd rpxd-live
bun install
cd examples/kitchen-sink
bun run dev   # http://localhost:3000
```

That app exercises todos, chat (`/chat`), CSV import (`/import`), and an RSC
markdown page (`/doc`) — it doubles as the acceptance suite.

## The CLI

`@rpxd/cli` is both the app runtime and a code generator.

### Run an app

| Command | What it does |
| --- | --- |
| `rpxd dev` | One Bun process: Vite in middleware mode (HMR, codegen watcher) + the rpxd runtime, on one port. |
| `rpxd build` | Production client + server bundles (`vite build`), plus the RSC bundle when enabled. |
| `rpxd start` | Runtime over the build — no Vite. Bun by default; the `node:http` adapter (Node ≥ 24) when run off-Bun. |

All three accept flags that override `rpxd.config.ts`, handy for exercising one
app across transports and render modes without editing the config:

```sh
rpxd dev --transport ws        # force WebSocket transport
rpxd dev --transport sse       # force Server-Sent Events (default)
rpxd dev --rsc                 # enable RSC fields
rpxd dev --no-rsc              # disable RSC fields
```

`PORT` (env) sets the port for `dev` and `start` (default `3000`).

### Scaffold

The generators write real files — routes, `domain/` modules, `adapters/` — and
re-run codegen. Nothing is hidden behind runtime magic; everything they emit is
yours to edit.

| Command | What it does | Flags |
| --- | --- | --- |
| `rpxd init [dir]` | Scaffold a new app in `dir` (default `.`). Wires Better Auth + Prisma/SQLite by default. | `--no-auth`, `--no-db`, `--force` (write into a non-empty dir) |
| `rpxd auth` | Add Better Auth + Prisma to an existing app. | `--force` (overwrite existing files) |
| `rpxd scaffold <Context> <Schema> <plural> [field:type…]` | Generate a resource — a live route (or HTTP `route()`), its `domain/` module, and a test. | `--kind page\|http` (default `page`), `--protected` (gate behind auth), `--no-test`, `--force` |

```sh
# a new app with auth + a database
bunx rpxd init my-app

# a Todos resource: a live page at /todos plus domain/todos + a test
bunx rpxd scaffold Todos Todo todos text:string done:boolean

# a protected resource served as an HTTP route instead of a page
bunx rpxd scaffold Orders Order orders total:number --kind http --protected
```

## Project layout

Userland is a config file plus a `routes/` directory — the framework owns the
server, client entry, hydration, and bundling.

```
my-app/
├── routes/                 # the web edge — file-based routing
│   ├── __root.tsx          #   HTML shell + providers
│   ├── __404.tsx           #   unmatched URL
│   ├── __error.tsx         #   mount rejection / handler crash
│   ├── index.tsx           #   /            live object
│   └── org.$orgId.board.tsx #  /org/$orgId/board
├── domain/                 # your app logic — bounded modules
├── adapters/               # server-only clients (db, auth)
└── rpxd.config.ts          # storage, transport, session.authenticate
```

Filenames are flat and map by dots: `org.$orgId.board.tsx` →
`/org/$orgId/board`, `index.tsx` → `/`. A `$` segment is a path param;
`.tsx`/`.jsx` files export a `live()` object, `.ts`/`.js` files export a
`route()` (a plain HTTP endpoint). See [Routing](/rpxd-live/guides/routing/).

## Configuration

`rpxd.config.ts` is the only non-route file:

```ts
import { defineConfig } from "@rpxd/cli";
import { sqlite } from "@rpxd/storage-sqlite";

export default defineConfig({
  storage: sqlite("./data.db"),      // memory() default; session(), redis() too
  transport: sse(),                  // default; ws() opt-in
  session: {
    authenticate: (req, { sid }) => ({ sid }),
  },
  rsc: false,                        // RSC fields — opt-in
});
```

Next: [build your first live object](/rpxd-live/getting-started/first-live-object/).
