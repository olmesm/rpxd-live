# rpxd

Live objects for React: server-side stateful objects with reducers; the
client is plain React receiving state. Immer patches stream over SSE;
optimistic updates replay client-side; multiplayer rides pubsub.

**Docs:** [olmesm.github.io/rpxd-live](https://olmesm.github.io/rpxd-live/) · **Spec:** [`spec.md`](./spec.md) · **Wire protocol:** [Wire protocol](https://olmesm.github.io/rpxd-live/concepts/wire-protocol/) · **App structure:** [App structure](https://olmesm.github.io/rpxd-live/guides/domain-layer/) · **Routes & auth:** [Routes & auth](https://olmesm.github.io/rpxd-live/guides/routes-and-auth/)

The user-facing documentation site (guides, concepts, auto-generated API
reference) is built with [Astro Starlight](https://starlight.astro.build/) from
`docs-site/` and deploys to GitHub Pages on push to `main`.

```tsx
// routes/org.$orgId.board.tsx — one live object per page, fully inferred
export default live("/org/$orgId/board")
  .setup((ctx) => {
    ctx.subscribe(`org:${ctx.params.orgId}`);
    return { projects: [] as Project[] }; // sync skeleton — data loads in `load`
  })
  .load(async (_url, ctx) => {
    const projects = await db.project.findMany({ where: { orgId: ctx.params.orgId } });
    ctx.patchState((s) => { s.projects = projects; });
  })
  .rpc("create", (r) =>
    r.input(z.object({ name: z.string() })).handler(async ({ name }, ctx) => {
      const p = await db.project.create({ data: { orgId: ctx.params.orgId, name } });
      ctx.patchState((s) => { s.projects.push(p); });
      ctx.broadcast(`org:${ctx.params.orgId}`, "project.created", p);
    }),
  )
  .on("project.created", (state, p) => { state.projects.push(p); })
  .render(({ state, rpc, sync, keyOf }) => (
    <ul>{state.projects.map((p) => <li key={keyOf(p.id)}>{p.name}</li>)}</ul>
  ));
```

## Try it

```sh
bun install
cd examples/kitchen-sink && bun run dev   # http://localhost:3000 — todos, /chat, /import, /doc, /stream
```

## Packages

Each package has its own README.

| Package | What it is |
| --- | --- |
| [`@rpxd/core`](./packages/core) | server runtime: `live()`, per-instance FIFO queue, patches, protocol, storage seam, pubsub |
| [`@rpxd/client`](./packages/client) | `LiveStore` (optimistic replay, `keyOf`, batching), `LiveConnection` (SSE/WS), `LiveApp`, `Link`/`nav` |
| [`@rpxd/server-bun`](./packages/server-bun) | `ServerAdapter` seam + HTTP/SSE/WS runtime handler (sessions, SSR attach, eviction) |
| [`@rpxd/vite-plugin`](./packages/vite-plugin) | route codegen (`.rpxd/routes.gen.ts`), path-literal maintenance |
| [`@rpxd/cli`](./packages/cli) | `rpxd dev/build/start`, `defineConfig`, zero-config app shell |
| [`@rpxd/testing`](./packages/testing) | `testLive(route)` harness: typed `t.rpc.*` against the real runtime |
| [`@rpxd/storage-*`](./packages/storage-memory) | memory / session / sqlite (`bun:sqlite`) / redis adapters |
| [`@rpxd/rsc`](./packages/rsc) | RSC fields (§16, `rsc: true`): Flight-serialized subtrees with `'use client'` islands |
| [`@rpxd/adapter-node`](./packages/adapter-node) | `ServerAdapter` seam placeholder — no implementation; rpxd runs on Bun |

## Development

TDD-first — see [`CLAUDE.md`](./CLAUDE.md) for conventions.

```sh
bun run test        # Vitest unit + type tests
bun run typecheck   # tsc
bun run lint        # Biome
bun test packages/*/test-bun examples/kitchen-sink/test-bun   # Bun-runtime tests
cd e2e && bunx playwright test                                # browser acceptance
```
