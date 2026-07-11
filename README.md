# rpxd

rpxd is a live-object framework for React. Instead of an API layer, a client
store, a cache, and optimistic-update plumbing, you write one **live object**
per page: a stateful object that lives on the server, with reducers and a
plain React render. rpxd streams state changes to the browser as minimal
patches, replays optimistic updates on the client, and coordinates
multiplayer through pubsub.

> **Status: pre-1.0.** Published as `@rpxd/*` on npm — `bunx @rpxd/cli init my-app`
> to scaffold a project, or clone this repo to explore. APIs may still change
> before 1.0.

**[Documentation](https://olmesm.github.io/rpxd-live/)** ·
[Spec](./spec.md) ·
[Wire protocol](https://olmesm.github.io/rpxd-live/concepts/wire-protocol/)

A complete page looks like this:

```tsx
// routes/counter.tsx
export default live("/counter")
  .setup(() => ({ count: 0 }))
  .rpc("inc", (r) =>
    r.handler(async (_payload, ctx) => {
      ctx.patchState((s) => { s.count += 1; });
    }),
  )
  .render(({ state, rpc }) => (
    <button type="button" onClick={() => rpc.inc()}>
      count: {state.count}
    </button>
  ));
```

`setup` declares the state, `rpc`s are reducers that run on the server, and
`render` is ordinary React with fully typed props — no type annotations, no
codegen. For a page with data loading, validation, optimistic updates, and
multiplayer broadcasts, see the
[introduction](https://olmesm.github.io/rpxd-live/getting-started/introduction/).

## Try it

```sh
bun install
cd examples/kitchen-sink
bun run setup   # prisma generate + db push — required before the first `dev`
bun run dev     # http://localhost:3000 — todos, /chat, /import, /doc, /stream
```

## Packages

Each package has its own README.

| Package | What it is |
| --- | --- |
| [`@rpxd/core`](./packages/core) | the server runtime: `live()`, reducers, patches, storage, pubsub |
| [`@rpxd/client`](./packages/client) | the browser side: optimistic replay, the live connection, `Link`/`nav` |
| [`@rpxd/server-bun`](./packages/server-bun) | the Bun HTTP/SSE/WebSocket server |
| [`@rpxd/adapter-node`](./packages/adapter-node) | run rpxd on Node (≥ 24) instead of Bun |
| [`@rpxd/cli`](./packages/cli) | `rpxd dev/build/start` and code generators — the zero-config app shell |
| [`@rpxd/vite-plugin`](./packages/vite-plugin) | route codegen and typed navigation |
| [`@rpxd/testing`](./packages/testing) | `testLive(route)` — test live objects against the real runtime |
| [`@rpxd/storage-*`](./packages/storage-memory) | memory / session / SQLite / Redis storage adapters |
| [`@rpxd/rsc`](./packages/rsc) | React Server Components rendered into live state |

## Contributing

Development is TDD-first — see [`CLAUDE.md`](./CLAUDE.md) for conventions.

**Production:** rpxd is secure by default. Set `RPXD_SESSION_SECRET` (32+
random bytes) before deploying — the server refuses to start without it
unless `NODE_ENV=development`, since an unsigned session cookie is forgeable.

```sh
bun run test        # Vitest unit + type tests
bun run typecheck   # tsc
bun run lint        # Biome
bun test packages/*/test-bun examples/kitchen-sink/test-bun   # Bun-runtime tests
cd e2e && bunx playwright test                                # browser acceptance
```

The documentation site is built with
[Astro Starlight](https://starlight.astro.build/) from `docs-site/` and
deploys to GitHub Pages on push to `main`.
