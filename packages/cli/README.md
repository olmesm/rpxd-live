# @rpxd/cli

The rpxd command line and app shell: `rpxd dev`/`build`/`start` run an app,
`rpxd init`/`auth`/`scaffold` generate one, and `defineConfig` types your
config. This is the package an rpxd app actually runs — zero config, no entry
files to write.

## Getting started

```sh
bun add @rpxd/cli @rpxd/core @rpxd/client react react-dom
```

Not yet on npm — work from a clone of the repo for now.

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
bunx rpxd dev      # Vite + the live runtime on one port; edits hot-reload
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
  rsc: true,                      // React Server Components fields
});
```

## What the shell gives you

- **Framework-owned entries** — you never write a client entry or an SSR
  runtime; both are generated. Hydration, the live connection, and soft
  navigation are wired for you (and island hydration too, with `rsc: true`).
- **Dev**: one process, one port — Vite middleware (HMR, codegen watcher)
  plus the live wire. Edits to your route handlers hot-swap without losing
  instance state. Runtime errors get a sourcemapped overlay.
- **Prod**: `start` only serves; the server bundle owns rendering. Runtime
  errors render your `__error` page with a generic message and a reference
  id, while the real error goes to the server log.

Docs: https://olmesm.github.io/rpxd-live/
