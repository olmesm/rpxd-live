# rpxd — development conventions

rpxd is a live-object framework for React: server-side stateful objects with
reducers, Immer patches over SSE/WS, optimistic replay on the client. The
normative spec is `spec.md`; the wire protocol is `docs/protocol.md`.

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
- `bun test spikes/... packages/*/test-bun` — Bun-runtime tests (bun:sqlite,
  Bun.serve, Vite-on-Bun)

## Layout

- `packages/core` — server runtime: `live()`, queue, patches, storage seam, pubsub
- `packages/client` — LiveStore (optimistic replay), LiveConnection (SSE), Link/nav
- `packages/server-bun` — ServerAdapter seam + HTTP/SSE runtime handler
- `packages/vite-plugin` — route codegen, path-literal maintenance
- `packages/storage-*` — memory/session/sqlite/redis adapters
- `examples/todos` — the demo app; doubles as the acceptance suite target
- Tests live next to their package: `test/` (Vitest, Node) vs `test-bun/`
  (Bun runtime required).

## Conventions

- TSDoc on all public APIs with `@example` blocks (§17)
- Web-standard `Request`/`Response` in server code; Bun types only inside
  `bunAdapter` / storage-sqlite
- Rpc reducer params need explicit annotations (both forms): TS can't
  contextually type through the plain/generator handler union, and
  reverse-mapped payload inference from `input` schemas is unreliable on
  TS 6 (verified — see `packages/core/test/live.test-d.ts` header). Use
  `InferOutput<typeof schema>` to keep payload annotations DRY. `mount`,
  `on`, and `params` infer without annotations.
