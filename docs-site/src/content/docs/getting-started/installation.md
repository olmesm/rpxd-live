---
title: Installation
description: Set up an rpxd project, run the dev server, and understand the project layout.
sidebar:
  order: 2
---

rpxd runs on [Bun](https://bun.sh). The runtime uses `Bun.serve` (HTTP + WS on
one port) and `bun:sqlite`; Vite runs on Bun for dev and build.

## Try the example

The fastest way to see rpxd is the `todos` example in the repo:

```sh
git clone https://github.com/olmesm/rpxd-live
cd rpxd-live
bun install
cd examples/todos
bun run dev   # http://localhost:3000
```

That app exercises todos, chat (`/chat`), CSV import (`/import`), and an RSC
markdown page (`/doc`) — it doubles as the acceptance suite.

## The CLI

`@rpxd/cli` gives you three commands:

| Command | What it does |
| --- | --- |
| `rpxd dev` | One Bun process: Vite in middleware mode (HMR, codegen watcher) + the rpxd runtime, on one port. |
| `rpxd build` | Production client + server bundles (`vite build`), plus the RSC bundle when enabled. |
| `rpxd start` | Pure Bun runtime over the build — no Vite at runtime. |

Every command accepts flags that override `rpxd.config.ts`, handy for
exercising one app across transports and render modes:

```sh
rpxd dev --transport ws        # force WebSocket transport
rpxd dev --transport sse       # force Server-Sent Events (default)
rpxd dev --rsc                 # enable RSC fields
rpxd dev --no-rsc              # disable RSC fields
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
