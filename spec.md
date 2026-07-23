# rpxd — v1 Specification

## 1. Live Objects (Core Model)
Server-side stateful objects with reducers; client is plain React receiving state.

- One live object per page; everything below is ordinary React fed via props. A page may **compose** further live objects as slots (`<LiveSlot>`) and share a persistent layout — see ADR 0002; the base model is unchanged
- Instances are **per-session**; multiplayer via pubsub (no shared instances, no `key`/`scope`)
- **Lifecycle by cadence** (§7): `setup` (sync) runs on identity — a **path-param** change — and returns the state skeleton + wires subscriptions; `guard` (async, optional) and `load` (async) run on **every URL change** (path *or* search); `load` is the single place URL-dependent data loads. `guard` is auth (deny → `redirect`); `load` streams data via `ctx.patchState`
- Handlers run server-side as plain async fns; state writes go through `ctx.patchState(mut)` — sync Immer mutators, exact patches; `ctx.state` is a live read-only view (always current, even after awaits)
- Per-instance FIFO queue serializes **mutations** (patchState flushes, `on` handlers, `load`) — LWW by ordering. Handlers never hold it: awaits don't block the instance (concurrency by default)
- Render props: `state`, `session`, `rpc`, `sync` (`pending`, `errors`), `nav`, `keyOf`

```tsx
// routes/org.$orgId.board.tsx — fluent chain: state shape locks at .setup(),
// everything downstream infers from it (zero annotations)
export default live("/org/$orgId/board")
  .setup((ctx) => {                                     // sync: subscriptions + skeleton (§1, §8)
    ctx.subscribe(`org:${ctx.params.orgId}`);
    return { projects: [] as Project[], filter: "all", loading: true };
  })
  .guard(async ({ params }, ctx) => {                   // auth, every URL change (§10)
    if (!(await canView(ctx.session, params.orgId))) throw redirect("/403");
  })
  .load(async ({ params, props }, ctx) => {             // the loader (§7): every URL change
    ctx.patchState((s) => { s.filter = props.filter ?? "all"; s.loading = true; });
    const projects = await db.project.findMany({ where: { orgId: params.orgId, ...where(props.filter) } });
    ctx.patchState((s) => { s.projects = projects; s.loading = false; });
  })
  .rpc("create", (r) =>
    r.input(z.object({ name: z.string() })).handler(async ({ name }, ctx) => {
      const p = await db.project.create({ data: { orgId: ctx.params.orgId, name } });
      ctx.patchState((s) => { s.projects.push(p); });
      ctx.broadcast(`org:${ctx.params.orgId}`, "project.created", p);
    }),
  )
  .on("project.created", (state, p) => { state.projects.push(p); })
  .render(({ state, session, rpc, sync, keyOf }) => ( /* plain React */ ));
```

## 2. Patch Protocol & Wire Envelope
Immer patches over a push stream with seq numbers; full snapshot as recovery.

- Every `patchState`/handler flush wrapped in `produceWithPatches`; patches pushed to subscriber
- String-suffix growth (`s.text += delta`) compiles to an **`append` patch op** carrying only the delta — LLM/token streams are O(delta) on the wire, not O(total)
- Envelope: `{ seq, patches | full, rpcId?, idMap?, error? }` — **transport-agnostic** (full envelope + framing in the wire-protocol doc)
- Session-slice patches share the stream, namespaced paths (`["$session", ...]`)
- Seq gap detected client-side → request full snapshot
- Batched rpcs (§6) emit one combined patch + one ack
- Structural sharing preserved end-to-end (patch apply + optimistic view derivation via `produce`) → memoized children skip re-renders off the patch path

## 3. Async Handlers & patchState (Streaming)
Handlers are plain async fns; `ctx.patchState(mut)` is the only write; every flush is one patch envelope.

- `handler(payload, ctx)` — awaits **never block the instance**; other rpcs, broadcasts, and `load` run freely while a handler waits (concurrency by default, no flag)
- `ctx.state`: live read-only view — reads after `await` see current state; writes throw ("use ctx.patchState")
- `ctx.patchState(mut)`: `mut` is a **sync** Immer mutator on a fresh draft → exact patches. Same-tick calls from one rpc coalesce into one flush; each flush = one envelope. Drafts never escape the callback → the stale-draft bug class is structurally impossible (no lint rule needed)
- **Streaming = a loop**: `for await (chunk) { ctx.patchState(...) }` — one envelope per chunk tick
- **Whole-rpc all-or-nothing** is userland: do the fallible work first (or `try/catch` + accumulate), then `patchState` once at the end — a throw before that terminal write applies nothing. `.onError` repairs *state* after a throw
- **Cancellation**: `ctx.signal` aborts on disconnect/eviction — pass it to fetch/SDKs; `ctx.abort(name)` aborts in-flight invocations of a named rpc (the stop-generating pattern)
- `sync.pending` spans call → ack (handler completion)

```ts
.rpc("ask", (r) =>
  r.input(z.object({ prompt: z.string() })).handler(async ({ prompt }, ctx) => {
    ctx.patchState((s) => { s.answer = ""; s.thinking = true; });
    const stream = llm.stream(prompt, { signal: ctx.signal });
    for await (const delta of stream) {
      ctx.patchState((s) => { s.answer += delta; });   // → append op, O(delta) wire
    }
    ctx.patchState((s) => { s.thinking = false; });
  }),
)
.rpc("stop", (r) => r.handler(async (_p, ctx) => { ctx.abort("ask"); }))
```

## 4. Optimistic Updates (Fn-Replay)
Client-side optimistic functions replayed over confirmed state — never merged patches.

- Model: `confirmed` (server truth) + pending fn queue; `view = replay(pending, confirmed)`
- Ack → apply patch to confirmed, drop fn; error → drop fn (free rollback); replay throws → drop silently
- Optimistic fns: **sync, pure, identity-based lookups** (`find(id)`, never
  index — a convention documented in TSDoc; a custom Biome rule is deferred
  (needs flow analysis beyond GritQL plugins today, see CLAUDE.md))
- Creates: `ctx.tempId()` placeholder
- **Id linking by position matching**: runtime records where tempId lands in the optimistic patches (path + sub-path — any field name, nested ok); matches the corresponding `add` op in ack patches; reads the same sub-path → `idMap: { tempId → realId }`. Client-side only; `ctx.resolveId()` escape hatch for unmatched shapes
- **`keyOf(id)`** render prop applies the map at render: returns original tempId for optimistically-created rows, else id unchanged → stable React keys, no remount, no wire rewriting

```tsx
{state.todos.map((t) => <li key={keyOf(t.todoId)}>{t.text}</li>)}
```

## 5. RPC Fluent Chain
`.rpc(name, r => r.input().optimistic().handler().onError())` — validation, optimism, types, and recovery in one chain.

- `input(schema)`: Standard Schema (Zod/Valibot/ArkType); validated client-side (pre-optimistic) **and** server-side; **locks the payload type** for every later step
- `.handler(async (payload, ctx) => ...)`: the single terminal — plain, streaming, and slow work are all just async fns (§3)
- **`.onError((state, error, payload, ctx) => ...)`**: sync mutator run as a queued flush on handler throw → patches ride the error ack. Repairs *state*, not the database — DB atomicity stays userland transactions
- `.rateLimit(limit)`: per-rpc token bucket (§10)
- Without `input`, the payload type comes from the handler's own annotation (or `unknown`)
- **Typed rpc record**: each `.rpc(name, ...)` extends an accumulated `{ name → payload }` type; `.render()` hands the component a payload-typed, exact-keyed `rpc` facade — unknown names and wrong payloads are compile errors. Types flow through `optimistic`, `handler`, `onError`, **and the client `rpc.*` signature** with no codegen
- Chains evaluate to the same runtime long-form object the server consumes — the fluent API is construction-time only

```ts
.rpc("importCsv", (r) =>
  r
    .input(z.object({ url: z.string().url() }))
    .handler(async ({ url }, ctx) => {
      const rows = await fetchCsv(url);                       // instance not blocked
      for (const chunk of batches(rows)) {
        const inserted = await insert(chunk);
        ctx.patchState((s) => { s.projects.push(...inserted); }); // flush per chunk
      }
    })
    .onError((state) => {
      state.importing = false;
      state.lastError = "Import failed";
    }),
)
```

## 6. Transport Batching
Same-tick rpc calls coalesce into one request/frame, one combined patch, one ack.

- Flush on `queueMicrotask` (not RAF — background-tab safe)
- No pipelining layer: multi-step ops are one reducer ("chatty client = missing reducer")

## 7. Routing
File-based with codegen; wouter under the hood; URL is identity.

- Flat filenames: `org.$orgId.board.tsx` → `/org/$orgId/board`; `index.tsx` → `/`
- **In-file path literal** (`live("/org/$orgId/board")`) scaffolded and maintained by the watcher — filename is truth, literal is its typed mirror (rename → rewritten; hand-edit → corrected)
- Path params inferred from the literal → typed in `setup`/`guard`/`load`/`rpc` ctx (`ctx.params`)
- `.rpxd/routes.gen.ts` generated + committed; `Register` interface merge → typed `<Link to params>` and `nav.navigate`
- **Three lifecycle hooks, keyed by cadence:**
  - **`setup((ctx) => S)`** — **sync**. Runs on identity (a **path-param** change). Wires subscriptions (§8), returns the state skeleton (locks type `S`). No IO — being sync makes "all data loads in `load`" a structural guarantee, and keeps a path step's skeleton instant. May `throw redirect` for a coarse fail-fast, but auth's home is `guard`.
  - **`guard(({ params, props }, ctx) => void)`** — async, optional. Runs before `load` on **every URL change** (path *or* props). Auth: `throw redirect` to deny. It runs on props changes too, so a spoofed/edited `?cursor=…` or `?userId=…` is re-checked (§10).
  - **`load(({ params, props }, ctx) => void)`** — async. The single place URL-dependent data loads. Runs after `setup` and on **every URL change**. First arg is the whole URL (`params` = path, `props` = the URL query record — a page's query string is its props); writes **page state** via `ctx.patchState`; `ctx.session` is read-only. Loading/errors are ordinary state — no ack. **Latest-wins**: a newer invocation aborts the prior's `ctx.signal` and drops its late flushes. Pass `ctx.signal` to `fetch`. `throw redirect` to deny. The URL is the query key → filtering/pagination are shareable, bookmarkable, back-button-correct, reproducible on cold wake.
- **Navigation — three tiers, two verbs.** `nav.patch(props)` changes props (the URL query) only (tier 1): reruns `guard`+`load`, no `setup`, **state preserved** (keepPreviousData + optimistic survive). `nav.navigate(...)` changes the path: **same route pattern** (tier 2) mounts the target identity over the **reused connection** (soft reload — the SSE + app shell survive; the page component is keyed by path id so its local state resets); **different route** (tier 3) swaps the component over the same app-lifetime connection. The framework picks tier 2 vs 3 by matched pattern; userland only calls `patch`/`navigate`.
- **Path vs search is a continuity knob**: search change (tier 1) preserves state (keepPreviousData); path change (tier 2/3) resets the page's *local React* state and swaps which instance is rendered. A **never-seen identity** runs `setup`+`guard`+`load` fresh (skeleton); a **warm identity** (still in this session's warm TTL — e.g. a return navigation) is reused with its instance state intact: `guard` reruns, `load` reruns only if props changed (ADR 0002, warm-mount dedup). Instance state lives with the session, not with the DOM. Model a continuity stepper as `?id=`, a clean switch as `/…/$id`.
- **Props typing** — untyped by default (`Record<string, string | undefined>`, the raw query record). Declare a schema with `live(pattern, propsSchema?)` (ADR 0002) and `guard`/`load` receive **validated, decoded** props: the URL codec is per-value try-`JSON.parse`, else raw string, so `?limit=20` arrives as the number `20` while `?filter=done` stays `"done"` — the ambiguous cases (`"20"`, `"true"`) round-trip because the writer quotes them. Decode + validate happen on the page GET **before** `guard`, so untrusted input never reaches userland unvalidated (a schema violation → 422); the codec is applied **only** when a schema is declared (schema-less routes keep raw strings)
- Wouter unexported; public surface = `Link`, `nav`

## 8. Pubsub (Multiplayer)
Per-session instances coordinated by broadcast; persistence layer carries the bus.

- `ctx.subscribe(topic)` in `setup` (re-runs on a path change → subscription set always matches the current identity, no stale subs); `ctx.broadcast(topic, event, payload)` in rpcs; `.on(event, ...)` handlers are sync mutators
- **Exclude-self by default**; `{ self: true }` opt-in enables single-code-path pattern (rpc broadcasts only, all mutation in `on`)
- Kills instance affinity: any node hosts any session

## 9. Persistence Adapters
Write-through snapshots behind a small interface; also hosts the pubsub bus.

- `StorageAdapter`: `get/set/delete` of `{ state, session, seq, version }` + pubsub — `session` is restored on cold wake alongside `state`; adapters: `memory()` (default), `session()`, `sqlite()` (via `bun:sqlite`; Node adapter uses `better-sqlite3`), `redis()`
- Write-through on every patchState flush / rpc completion
- **Snapshots = session continuity only**; cold wake always re-runs `setup`+`load` (avoids missed-broadcast staleness)
- Version tag mismatch → discard, re-setup (no migrations)
- Whole-state snapshots, never patch logs

## 10. Sessions, Auth & Errors
Connection authenticated once; context flows to every reducer.

- Authenticate at connect (cookie/token) via config hook → `ctx.session` everywhere
- **Authorization is `guard`** (§7): runs before `load` on every URL change — path *and* search — so it re-checks on `nav.patch` too (a spoofed `?cursor=…`/`?userId=…` can't expose data). `throw redirect` denies → 302 (full load) / soft-nav (patch). `setup` may also `throw redirect` for a coarse identity fail-fast, but per-URL authz belongs in `guard`
- `load` may `throw redirect` as well — honored **before its first patch** (§12); after it the run is mid-stream and the redirect is ignored (logged server-side). A redirect thrown in `setup`/`guard`/`load` is control-flow (→ route), distinct from a data throw (→ `sync.errors`)
- Handler throws: draft discarded, ack rejected, `onError` runs if declared (§5), `sync.errors` populated
- **DB writes are userland's transaction responsibility** (documented)
- Per-session rate limiting (token bucket), configurable per rpc — buckets are per rpc *per instance*; with per-session instances (§1) that is per session per route, a finer grain than a shared per-session pool

## 11. Connection Lifecycle & Transport
Connections are disposable; state is not. SSE default, WS opt-in.

- **Server → client**: SSE (default) — one-way patch stream, `EventSource` auto-reconnect, proxy-friendly. **Client → server**: HTTP POST (batched per §6)
- `transport: ws()` config opt-in — single duplex connection, lower per-rpc overhead; **API shape identical** (envelope is transport-agnostic, no codegen impact)
- `status: 'connecting' | 'live' | 'reconnecting' | 'error'`
- Reconnect: resubscribe with last seq → full snapshot + new seq (identical either transport)
- Unacked optimistic rpcs resent with client-generated rpc ids (server dedupes)
- Eviction: subscribers = 0 → warm TTL (~60s) → snapshot + evict
- Disconnect mid-handler → `ctx.signal` aborts (§3)

## 12. SSR
`setup`+`guard`+`load` run during SSR; connection adopts the warm instance.

- HTTP → `setup` → `guard` → `load` → HTML + embedded `{ snapshot, seq, attachToken }`
- Connection presents token within pending-attach TTL (~10s) → adopts instance, resumes from seq
- Token expired → silent re-setup + full snapshot; seq check covers gap broadcasts
- `setup` runs **once** per identity; no connect-spinner; crawlable
- **SSR sequencing** — the first document carries state through `load`'s **first patch**; everything after it streams. In order: (1) `setup`'s skeleton (sync, instant); (2) `load`'s first patch. If that first patch is **synchronous** (a projection — filter/loading chrome — before `load`'s first `await`) it renders immediately and the awaited data streams over the push stream after hydration (fast TTFB; a crawler/no-JS client sees the chrome, not the rows). If `load` **awaits before its first patch**, the renderer waits for that patch, so the first paint carries data (crawlable, no spinner) at the cost of TTFB. The author picks by loader structure — no flag. Deterministic: capture is keyed to *the first patch*, never a timer. A `redirect` thrown in `setup`/`guard`/`load` before the first patch → 302

## 13. Out of Scope
Deliberately not covered by this spec; the seams below keep each addable later without a rewrite.

- ~~Nested/sibling live objects + layouts (requires nested live semantics)~~ — **shipped** in ADR 0002 (live slots + `__layout.tsx`); the deferral was overpriced, the control plane was multi-instance from day one. Still deferred there: SSR for slots, cross-instance optimism, runtime-federated microfrontends
- Transparent id aliasing (wire rewriting) if `keyOf` proves insufficient
- Devtools time-travel (patch log makes it cheap)
- Presence recipe (userland, ~20 lines)
- CRDT field type for collaborative text
- Per-rpc `concurrent` flag

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
  __error.tsx            → setup/guard/load rejection / handler crash
  index.tsx              → /
  org.$orgId.board.tsx   → /org/$orgId/board
rpxd.config.ts
```

- **Runtime: Bun primary** — `Bun.serve` (HTTP + WS one port), `bun:sqlite`
- **Node runtime (Node ≥ 24)**: `@rpxd/adapter-node` mirrors the Bun adapter over `node:http` + `ws`; `rpxd start` selects it automatically off-Bun. Node's unflagged TypeScript stripping runs the source directly (the runtime is kept erasable — no parameter properties/enums), and `@rpxd/storage-sqlite/node` swaps `bun:sqlite` for `better-sqlite3`
- **`ServerAdapter` seam from day one**: `serve` / `stream` (SSE) / `ws?` / `env` — web-standard `Request`/`Response`/`ReadableStream` internally, no Bun types past the boundary → the Node adapter is a small `node:http` bridge
- **Vite = dev server + bundler, running on Bun**: `rpxd dev` = one Bun process, Vite in middleware mode (HMR, Fast Refresh, codegen watcher) + rpxd runtime, one port. `rpxd build` = `vite build` (client + SSR bundles); `rpxd start` = pure Bun, no Vite at runtime
- rpxd Vite plugin owns: route codegen (§7), reducer HMR (§15), RSC wiring (§16)
- DB is userland (`db.ts` import); framework never touches it

## 15. DX
- Reducers unit-testable as plain fns with mock ctx
- HMR preserves runtime state across reducer edits

## 16. RSC Fields (experimental flag)
Server-rendered component subtrees as opaque state values; Flight is the serialization, patches the transport.

- `rsc(<Component />)` in `load`/reducers → `RscField` marker (`{ $rsc: string }`) carrying a Flight payload → opaque state field; heavy deps (markdown, shiki) never ship to client
- Client deserializes marked fields on patch apply/snapshot; `{state.body}` renders hydrated subtree
- Patches replace the whole field (no Flight diffing); React reconciles
- Works through storage, SSR, reconnect unchanged — it's just an opaque marker value in state
- Built on `@vitejs/plugin-rsc` (TanStack's approach — integrate, don't own the bundler layer)
- Constraints: RSC fields never optimistic; not for keystroke-frequency updates; `'use client'` islands hydrate via plugin manifest
- **Isolation**: `rsc: false` is the default; RSC fields are strictly opt-in, so nothing in the core runtime depends on the bundler integration
- **Reserved key**: `$rsc` is reserved for framework-produced Flight fields; the marker is structural (no brand), so app code must never put user-controlled data into state shaped `{ $rsc: string }` (non-forgeable brand tracked as issue #95)

```tsx
load: async ({ params }, ctx) => {
  const doc = await db.doc.find(params.slug);
  ctx.patchState((s) => { s.body = rsc(<Markdown source={doc.raw} />); });
},
```

## 17. Monorepo, Tooling & Documentation Standards

```
rpxd/
  packages/
    core/            # runtime: queue, patches, protocol, live()
    client/          # useLive, optimistic replay, keyOf, Link/nav
    server-bun/      # Bun ServerAdapter (primary)
    adapter-node/    # Node ServerAdapter (node:http + ws)
    storage-memory/
    storage-sqlite/  # bun:sqlite (+ better-sqlite3 via ./node)
    storage-redis/
    storage-session/
    vite-plugin/     # codegen, HMR, RSC wiring
    cli/             # rpxd dev/build/start
    rsc/             # RSC fields (§16): rsc(), RscField marker
    testing/         # testLive(route) harness
  examples/
    kitchen-sink/             # demo app — Playwright runs against this
  e2e/               # Playwright: SSR attach, reconnect, optimistic, multiplayer, streaming
```

- **Bun workspaces** (no turborepo/nx — `bun run --filter` covers it)
- **Biome** — lint + format, single root config; would be the home for custom rules (the §4 identity-based-lookups rule is deferred — see §4)
- **Vitest** — unit tests: reducers/queue/replay per package
- **Playwright** — e2e against `examples/kitchen-sink`; the demo doubles as the acceptance suite for §1–§12
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

