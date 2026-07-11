# rpxd — development conventions

rpxd is a live-object framework for React: server-side stateful objects with
reducers, Immer patches over SSE/WS, optimistic replay on the client. The
normative spec is `spec.md`; the wire protocol is
`docs-site/src/content/docs/concepts/wire-protocol.md`.

## Workflow

- **TDD first.** Write the failing test before the implementation — unit
  (Vitest), type (`*.test-d.ts`), Bun-runtime (`test-bun/`), or e2e
  (Playwright) depending on the surface. No new behavior lands without a
  test that failed first.
- Work on feature branches; merge to main only when CI is green.
- Every 5 merges: run `bunx fallow dead-code` and address what it flags
  (judgement allowed — library public API and dynamically-loaded files are
  common false positives).

## Commands

- `bun run test` — Vitest unit tests (packages/*/test)
- `bun run typecheck` — `tsc -p tsconfig.json`
- `bun run lint` / `bun run format` — Biome
- `bun test packages/*/test-bun` — Bun-runtime tests (bun:sqlite,
  Bun.serve, Vite-on-Bun)

## Layout

- `packages/core` — server runtime: `live()`, queue, patches, storage seam, pubsub
- `packages/client` — LiveStore (optimistic replay), LiveConnection (SSE), Link/nav
- `packages/server-bun` — ServerAdapter seam + HTTP/SSE runtime handler
- `packages/vite-plugin` — route codegen, path-literal maintenance
- `packages/storage-*` — memory/session/sqlite/redis adapters
- `packages/testing` — `testLive(route)` harness: typed `t.rpc.*`, envelope
  capture, broadcast injection, `t.settled()`
- `examples/kitchen-sink` — the demo app; doubles as the acceptance suite target
- Tests live next to their package: `test/` (Vitest, Node) vs `test-bun/`
  (Bun runtime required).

## Conventions

- TSDoc on all public APIs with `@example` blocks (§17) — enforced in CI by
  `bun scripts/check-tsdoc.ts`
- Deferred from §17: the custom Biome rule for §4 identity-based lookups
  needs flow analysis beyond GritQL plugins today; the convention is
  documented in TSDoc. (§3's getState-across-yield rule is obsolete — the
  patchState model makes the bug class unexpressible.)
- Web-standard `Request`/`Response` in server code; Bun types only inside
  `bunAdapter` / storage-sqlite
- `live()` is a fluent chain: `.setup()` (sync) locks state + wires
  subscriptions, `.guard()` gates access (auth), `.load()` is the URL loader,
  `.rpc(name, r => r.input().optimistic().handler())` locks payloads,
  `.render()` hands the component fully typed props including the exact-keyed
  `rpc` facade. Zero annotations needed; contract locked in
  `packages/core/test/live.test-d.ts`.
- Handlers are async `(payload, ctx)` and never block the instance; ALL
  state writes go through `ctx.patchState(sync mutator)`; `ctx.state` is a
  live read-only view. Whole-rpc all-or-nothing is userland (do the fallible
  work, then `patchState` once). String `+=` growth emits `append` patches.
- Bus `publish` is fire-and-forget (`void`) — never `await` it in a handler
  (that would block the instance, §8). The bus's optional `drain()` is the only
  awaitable seam; the test harness's `settled()` awaits it (scoped to
  local, this-process delivery — not cross-node fan-out).
- Framework diagnostics (rejections, denials, dropped messages, recovered
  errors) emit through the diagnostic sink — `RpxdDiagnostic`/`RpxdDiagnosticSink`
  from `@rpxd/core`, installed app-side via server-bun's `onDiagnostic` (#73) —
  never bare `console.*`. Every server emit site builds one
  `makeDiagnosticEmit(sink)` (which swallows a throwing sink) and reports a
  `{ category, type, level, detail?, error? }` diagnostic; core, instances, and
  storage adapters take an injected emit and fall back to
  `defaultDiagnosticSink` standalone. `console.*` is only for that default sink
  and the browser-side client (`packages/client`), which has no server hook.
  These framework diagnostics are distinct from the domain "events" of the
  typed-broadcast feature (`Register.events` / `ctx.broadcast`).
- **Secure by default; gate on `isDev()`, never `isProd`.** Environment-gated guards use `isDev()` from `@rpxd/core` (exactly `NODE_ENV === "development"`); the default is production. A missing/unexpected `NODE_ENV` is treated as production and keeps fail-closed guards on (e.g. an unsigned session cookie refuses to start outside dev). Never write an `isProd` check — it inverts the safe default.
