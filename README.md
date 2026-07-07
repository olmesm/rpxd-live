# rpxd

Live objects for React: server-side stateful objects with reducers; the
client is plain React receiving state. Immer patches stream over SSE;
optimistic updates replay client-side; multiplayer rides pubsub.

**Spec:** [`spec.md`](./spec.md) · **Wire protocol:** [`docs/protocol.md`](./docs/protocol.md)

```tsx
// routes/org.$orgId.board.tsx — one live object per page
export default live("/org/$orgId/board")({
  mount: async ({ orgId }, ctx) => {
    ctx.subscribe(`org:${orgId}`);
    return { projects: await db.project.findMany({ where: { orgId } }) };
  },
  rpc: {
    async create(state, { name }, ctx) {
      const p = await db.project.create({ data: { orgId: ctx.params.orgId, name } });
      state.projects.push(p);
      ctx.broadcast(`org:${ctx.params.orgId}`, "project.created", p);
    },
  },
  on: {
    "project.created": (state, p) => { state.projects.push(p); },
  },
})(({ state, rpc, sync, keyOf }) => (
  <ul>{state.projects.map((p) => <li key={keyOf(p.id)}>{p.name}</li>)}</ul>
));
```

## Try it

```sh
bun install
cd examples/todos && bun run dev   # http://localhost:3000 — todos, /chat, /import, /doc
```

## Packages

| Package | What it is |
| --- | --- |
| `@rpxd/core` | server runtime: `live()`, per-instance FIFO queue, patches, protocol, storage seam, pubsub |
| `@rpxd/client` | `LiveStore` (optimistic replay, `keyOf`, batching), `LiveConnection` (SSE), `Link`/`nav` |
| `@rpxd/server-bun` | `ServerAdapter` seam + HTTP/SSE runtime handler (sessions, SSR attach, eviction) |
| `@rpxd/vite-plugin` | route codegen (`.rpxd/routes.gen.ts`), path-literal maintenance |
| `@rpxd/cli` | `rpxd dev/build/start`, `defineConfig`, zero-config app shell |
| `@rpxd/storage-*` | memory / session / sqlite (`bun:sqlite`) / redis adapters |
| `@rpxd/rsc` | RSC fields (§16, experimental `rsc: true`) |
| `@rpxd/adapter-node` | v2 stub — seam proven by structure |

## Development

TDD-first — see [`CLAUDE.md`](./CLAUDE.md) for conventions.

```sh
bun run test        # Vitest unit + type tests
bun run typecheck   # tsc
bun run lint        # Biome
bun test spikes packages/*/test-bun examples/todos/test-bun   # Bun-runtime tests
cd e2e && bunx playwright test                                # browser acceptance
```
