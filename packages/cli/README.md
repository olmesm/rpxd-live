# @rpxd/cli

The rpxd app shell and command line: `rpxd dev`/`build`/`start` to run an app,
`rpxd init`/`auth`/`scaffold` to generate one, and `defineConfig`. This is the
package an rpxd app actually runs — zero config, no entry files to write.

## Getting started

```sh
bun add @rpxd/cli @rpxd/core @rpxd/client react react-dom
```

```
my-app/
  routes/
    index.tsx        # live("/") … .render(...)
    __root.tsx       # optional HTML shell
    __404.tsx        # optional unmatched-URL page
    __error.tsx      # optional crash page
  rpxd.config.ts     # optional — everything has defaults
```

```sh
bunx rpxd dev      # Vite + the live runtime on one port, reducer HMR
bunx rpxd build    # dist/client (hashed assets) + dist/server (SSR bundle)
bunx rpxd start    # serve the build with pure Bun — no Vite at runtime
```

`dev`/`build`/`start` accept `--transport <sse|ws>` and `--rsc` / `--no-rsc`
to override `rpxd.config.ts` — handy for exercising one app across every
render/transport combination without editing the config. `dev` and `start`
also take `--port <n>` to bind the port (the flag wins over `$PORT`, which
stays a fallback for platforms that inject it; default `3000`).

## Scaffolding

Generators write real files (routes, `domain/`, `adapters/`) and re-run
codegen — nothing is hidden behind runtime magic:

```sh
bunx rpxd init my-app                       # new app (Better Auth + Prisma/SQLite
                                            #   by default; --no-auth / --no-db)
bunx rpxd auth                              # add Better Auth + Prisma to an app
bunx rpxd scaffold Todos Todo todos text:string done:boolean
                                            # a resource: live route + domain +
                                            #   test (--kind http, --protected)
```

## Configuration

`rpxd.config.ts` is the only non-route file, and it's optional:

```ts
import { defineConfig, ws } from "@rpxd/cli";
import { sqlite } from "@rpxd/storage-sqlite";

export default defineConfig({
  storage: sqlite("data/app.db"), // default: memory()
  transport: ws(),                // default: sse()
  session: { authenticate: async (req, { sid }) => ({ sid, user: await userFrom(req) }) },
  rateLimit: { capacity: 20, refillPerSec: 5 },
  rsc: true,                      // Flight RSC fields (§16)
});
```

## What the shell gives you

- **Framework-owned entries** — the client entry and SSR runtime are
  virtual modules; hydration, live connection, soft navigation, and (with
  `rsc: true`) island hydration are wired for you.
- **Dev**: one process, one port — Vite middleware (HMR, codegen watcher)
  plus the live wire. Reducer edits hot-swap without losing instance state.
  Runtime errors get a sourcemapped overlay.
- **Prod**: `start` is transport-only; the server bundle owns rendering.
  Runtime errors render your `__error` page with a generic message + ref id
  while the real error goes to the server log.
