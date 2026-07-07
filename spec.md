# rpxd — v1 Specification

## 1. Live Objects (Core Model)
Server-side stateful objects with reducers; client is plain React receiving state.

- One live object per page; everything below is ordinary React fed via props
- Instances are **per-session**; multiplayer via pubsub (no shared instances, no `key`/`scope`)
- Reducers run server-side, async allowed, mutate Immer drafts (no return spreads)
- Per-instance FIFO queue: rpcs **and** broadcast handlers serialize through one queue (LWW by ordering)
- Render props: `state`, `session`, `rpc`, `sync` (`pending`, `errors`), `nav`, `keyOf`

```tsx
// routes/org.$orgId.board.tsx
export default live("/org/$orgId/board")({
  mount: async ({ orgId }, ctx) => {
    ctx.subscribe(`org:${orgId}`);
    return { projects: await db.project.findMany({ where: { orgId } }) };
  },
  params: (session, { filter }) => { session.filter = filter ?? "all"; },
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
})(({ state, session, rpc, sync, keyOf }) => ( /* plain React */ ));
```

## 2. Patch Protocol & Wire Envelope
Immer patches over a push stream with seq numbers; full snapshot as recovery.

- Every rpc/handler wrapped in `produceWithPatches`; patches pushed to subscriber
- Envelope: `{ seq, patches | full, rpcId?, idMap?, error? }` — **transport-agnostic**; written as one-page protocol doc first
- Session-slice patches share the stream, namespaced paths (`["$session", ...]`)
- Seq gap detected client-side → request full snapshot
- Batched rpcs (§6) emit one combined patch + one ack
- Structural sharing preserved end-to-end (patch apply + optimistic view derivation via `produce`) → memoized children skip re-renders off the patch path

## 3. Generator RPCs (Streaming)
`yield` = flush patches; `getState()` gives a fresh draft per segment; queue releases at yield.

- Signature signals semantics: plain reducers get `state` (whole-rpc atomic, blocks queue); generators get `getState` (per-segment drafts, **non-blocking**)
- Each segment between yields = one `produceWithPatches` = one atomic flush
- Queue releases at every `yield`; generator re-reads via `getState()` on resume
- Lintable convention (Biome rule, §17): never hold a `getState()` reference across `yield`/`await`
- **Early `return` allowed**: final segment flushed, ack sent; zero-yield return ≡ plain async reducer
- **Cancellation** (disconnect mid-run): runtime calls `generator.return()` → `finally` blocks run
- `sync.pending` spans the full run

```ts
async *importCsv(getState, { url }, ctx) {
  try {
    const rows = await fetchCsv(url);
    if (rows.length === 0) { getState().message = "Nothing to import"; return; }
    getState().importing = true; yield;
    for (const chunk of batch(rows)) {
      getState().projects.push(...await insert(chunk));
      yield;
    }
  } finally {
    getState().importing = false; // runs even on disconnect
  }
}
```

## 4. Optimistic Updates (Fn-Replay)
Client-side optimistic functions replayed over confirmed state — never merged patches.

- Model: `confirmed` (server truth) + pending fn queue; `view = replay(pending, confirmed)`
- Ack → apply patch to confirmed, drop fn; error → drop fn (free rollback); replay throws → drop silently
- Optimistic fns: **sync, pure, identity-based lookups** (`find(id)`, never index — Biome rule)
- Creates: `ctx.tempId` placeholder
- **Id linking by position matching**: runtime records where tempId lands in the optimistic patches (path + sub-path — any field name, nested ok); matches the corresponding `add` op in ack patches; reads the same sub-path → `idMap: { tempId → realId }`. Client-side only; `ctx.resolveId()` escape hatch for unmatched shapes
- **`keyOf(id)`** render prop applies the map at render: returns original tempId for optimistically-created rows, else id unchanged → stable React keys, no remount, no wire rewriting

```tsx
{state.todos.map((t) => <li key={keyOf(t.todoId)}>{t.text}</li>)}
```

## 5. RPC Long Form
`{ input?, optimistic?, handler, onError? }` — validation, optimism, types, and recovery in one declaration.

- `input`: Standard Schema (Zod/Valibot/ArkType); validated client-side (pre-optimistic) **and** server-side
- Types inferred through `optimistic`, `handler`, and client `rpc.*` signature
- **`onError(state, error, payload, ctx)`**: optional, runs as a queued reducer on handler throw → patches push normally. Essential for generators (repairs partially-flushed state). Repairs *state*, not the database — DB atomicity stays userland transactions
- Short form (bare fn) stays valid

```ts
importCsv: {
  input: z.object({ url: z.string().url() }),
  async *handler(getState, { url }, ctx) { ... },
  onError(state) {
    state.importing = false;
    state.lastError = "Import failed";
  },
}
```

## 6. Transport Batching
Same-tick rpc calls coalesce into one request/frame, one combined patch, one ack.

- Flush on `queueMicrotask` (not RAF — background-tab safe)
- No pipelining layer: multi-step ops are one reducer ("chatty client = missing reducer")

## 7. Routing
File-based with codegen; wouter under the hood; URL is identity.

- Flat filenames: `org.$orgId.board.tsx` → `/org/$orgId/board`; `index.tsx` → `/`
- **In-file path literal** (`live("/org/$orgId/board")`) scaffolded and maintained by the watcher — filename is truth, literal is its typed mirror (rename → rewritten; hand-edit → corrected)
- Path params inferred from the literal → typed in `mount`/`rpc` ctx
- `.rpxd/routes.gen.ts` generated + committed; `Register` interface merge → typed `<Link to params>` and `nav.navigate`
- **Path params = identity** → navigate = remount; **search params = view state** → `params` reducer via `nav.patch`, no remount
- Search params untyped in v1 (`Record<string, string | undefined>`)
- Wouter unexported; public surface = `Link`, `nav`

## 8. Pubsub (Multiplayer)
Per-session instances coordinated by broadcast; persistence layer carries the bus.

- `ctx.subscribe(topic)` in mount; `ctx.broadcast(topic, event, payload)` in rpcs; `on: {}` handlers mutate state
- **Exclude-self by default**; `{ self: true }` opt-in enables single-code-path pattern (rpc broadcasts only, all mutation in `on`)
- Kills instance affinity: any node hosts any session

## 9. Persistence Adapters
Write-through snapshots behind a small interface; also hosts the pubsub bus.

- `StorageAdapter`: `get/set` of `{ state, seq, version }` + pubsub; adapters: `memory()` (default), `session()`, `sqlite()` (via `bun:sqlite`; Node adapter uses `better-sqlite3`), `redis()`
- Write-through on rpc completion / yield flush
- **Snapshots = session continuity only**; cold wake always re-runs `mount` (avoids missed-broadcast staleness)
- Version tag mismatch → discard, re-mount (no migrations)
- Whole-state snapshots, never patch logs

## 10. Sessions, Auth & Errors
Connection authenticated once; context flows to every reducer.

- Authenticate at connect (cookie/token) via config hook → `ctx.session` everywhere
- `mount` can reject → error route (403 path)
- Handler throws: draft discarded, ack rejected, `onError` runs if declared (§5), `sync.errors` populated
- **DB writes are userland's transaction responsibility** (documented)
- Per-session rate limiting (token bucket), configurable per rpc

## 11. Connection Lifecycle & Transport
Connections are disposable; state is not. SSE default, WS opt-in.

- **Server → client**: SSE (default) — one-way patch stream, `EventSource` auto-reconnect, proxy-friendly. **Client → server**: HTTP POST (batched per §6)
- `transport: ws()` config opt-in — single duplex connection, lower per-rpc overhead; **API shape identical** (envelope is transport-agnostic, no codegen impact)
- `status: 'connecting' | 'live' | 'reconnecting' | 'error'`
- Reconnect: resubscribe with last seq → full snapshot + new seq (identical either transport)
- Unacked optimistic rpcs resent with client-generated rpc ids (server dedupes)
- Eviction: subscribers = 0 → warm TTL (~60s) → snapshot + evict
- Disconnect mid-generator → cancellation (§3)

## 12. SSR
Mount runs during SSR; connection adopts the warm instance.

- HTTP → mount → HTML + embedded `{ snapshot, seq, attachToken }`
- Connection presents token within pending-attach TTL (~10s) → adopts instance, resumes from seq
- Token expired → silent re-mount + full snapshot; seq check covers gap broadcasts
- Mount runs **once** per page load; no connect-spinner; crawlable

## 13. Deferred (v2+)
- Nested/sibling live objects + layouts (requires nested live semantics)
- Typed search params (per-route schema into `Register`, `nav.patch`, `Link`)
- Transparent id aliasing (wire rewriting) if `keyOf` proves insufficient
- Devtools time-travel (patch log makes it cheap)
- Presence recipe (userland, ~20 lines)
- CRDT field type for collaborative text
- Per-rpc `concurrent` flag
- Node server adapter (seam exists day one, §14)

## 14. Zero-Config App Shell, Runtime & Tooling
Userland = config file + `routes/`. Framework owns server, client entry, hydration, bundling.

```ts
// rpxd.config.ts — the only non-route file
export default defineConfig({
  storage: sqlite("./data.db"),
  transport: sse(), // default; ws() opt-in
  session: { authenticate: (req) => getSession(req) },
  rsc: false, // §16
});
```

```
routes/
  __root.tsx             → HTML shell + providers (static, no live state)
  __404.tsx              → unmatched URL
  __error.tsx            → mount rejection / handler crash
  index.tsx              → /
  org.$orgId.board.tsx   → /org/$orgId/board
rpxd.config.ts
```

- **Runtime: Bun primary** — `Bun.serve` (HTTP + WS one port), `bun:sqlite`
- **`ServerAdapter` seam from day one**: `serve` / `stream` (SSE) / `ws?` / `env` — web-standard `Request`/`Response`/`ReadableStream` internally, no Bun types past the boundary → Node adapter later is ~100 lines
- **Vite = dev server + bundler, running on Bun**: `rpxd dev` = one Bun process, Vite in middleware mode (HMR, Fast Refresh, codegen watcher) + rpxd runtime, one port. `rpxd build` = `vite build` (client + SSR bundles); `rpxd start` = pure Bun, no Vite at runtime
- rpxd Vite plugin owns: route codegen (§7), reducer HMR (§15), RSC wiring (§16)
- ⚠️ **Early smoke test**: Vite-on-Bun middleware mode with SSR — least-trodden path, verify before committing dev-server architecture
- DB is userland (`db.ts` import); framework never touches it

## 15. DX
- Reducers unit-testable as plain fns with mock ctx
- HMR preserves runtime state across reducer edits

## 16. RSC Fields (experimental flag — **implemented and tested last**)
Server-rendered component subtrees as opaque state values; Flight is the serialization, patches the transport.

- `rsc(<Component />)` in mount/reducers → Flight string → opaque state field; heavy deps (markdown, shiki) never ship to client
- Client deserializes marked fields on patch apply/snapshot; `{state.body}` renders hydrated subtree
- Patches replace the whole field (no Flight diffing); React reconciles
- Works through storage, SSR, reconnect unchanged — it's just a string in state
- Built on `@vitejs/plugin-rsc` (TanStack's approach — integrate, don't own the bundler layer)
- Constraints: RSC fields never optimistic; not for keystroke-frequency updates; `'use client'` islands hydrate via plugin manifest
- **Ordering guarantee**: `rsc: false` default means v1 is complete and shippable without it; flag flips only after ①–⑤ are stable — bundler integration must not destabilize the core

```tsx
mount: async ({ slug }) => ({
  doc: await db.doc.find(slug),
  body: rsc(<Markdown source={doc.raw} />),
}),
```

## 17. Monorepo, Tooling & Documentation Standards

```
rpxd/
  packages/
    core/            # runtime: queue, patches, protocol, live()
    client/          # useLive, optimistic replay, keyOf, Link/nav
    server-bun/      # Bun ServerAdapter (primary)
    adapter-node/    # stub, v2 (seam proven by structure)
    storage-memory/
    storage-sqlite/  # bun:sqlite
    storage-redis/
    storage-session/
    vite-plugin/     # codegen, HMR, RSC wiring
    cli/             # rpxd dev/build/start
  examples/
    todos/           # demo app — Playwright runs against this
  e2e/               # Playwright: SSR attach, reconnect, optimistic, multiplayer, generators
```

- **Bun workspaces** (no turborepo/nx in v1 — `bun run --filter` covers it)
- **Biome** — lint + format, single root config; home for custom rules (§3 getState-across-yield, §4 identity-based lookups)
- **Vitest** — unit tests: reducers/queue/replay per package
- **Playwright** — e2e against `examples/todos`; the demo doubles as the acceptance suite for §1–§12
- **Latest TS** (5.9+), latest deps, `"type": "module"` throughout
- **TSDoc mandatory on all public APIs** — `live`, `defineConfig`, adapters, render props, ctx methods — with `@example` blocks; enforced in CI
- **Generated code documented**: `.rpxd/routes.gen.ts` emits TSDoc on the route tree and `Register`; scaffolded path literals get a watcher-maintained comment

```ts
/**
 * Auto-generated route map — do not edit; maintained by `rpxd dev`.
 * Provides typed paths/params for {@link Link} and `nav.navigate`.
 * @example <Link to="/org/$orgId/board" params={{ orgId }} />
 */
export const routeTree = { ... };
```

---

**Build order**: ⓪ Vite-on-Bun SSR smoke test → ① protocol doc (§2 + §11) → ② runtime core (queue, patches, storage, pubsub) → ③ client (`useLive`, optimistic replay, batching, `keyOf`) → ④ routing codegen + SSR → ⑤ CLI/shell → ⑥ RSC fields (final).
