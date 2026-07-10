# Docs review — July 2026

A full review of the documentation (docs-site pages, package READMEs, `spec.md`,
and the landing page) against the codebase, with the audience in mind: React
developers evaluating and adopting a novel realtime framework. Every accuracy
finding below was verified against source with file:line evidence.

## Overall assessment

The docs are unusually strong on the **"how it works" axis** — the fluent
chain, optimistic replay, loading model, pubsub, testing harness, and auth
guides are precise, opinionated, and honest about trade-offs (the
infinite-scroll snapshot caveat is a model of the genre). `request-lifecycle.md`,
`pubsub.md`, and 10 of 12 package READMEs verified fully accurate.

Two problems dominate:

1. **The "can I ship it" axis is nearly empty.** There is no deployment,
   scaling, error-handling, or Node-runtime documentation — the questions an
   evaluator asks right after "this looks great."
2. **Accuracy drift is concentrated in exactly the wrong places**: the
   getting-started path (a quickstart that fails on a fresh clone, an install
   command for an unpublished package, a code sample that doesn't typecheck)
   and `wire-protocol.md`, the one page that declares itself normative.

---

## 1. Correctness fixes (do these first)

### 1.1 The getting-started path is broken today

- **Packages aren't on npm.** `npm view @rpxd/core` → 404, yet
  `installation.md:64` says `bunx rpxd init my-app`. Until publishing, the
  install page should say "not yet published — clone the repo" (or publish).
  Also inconsistent: `installation.md` uses `bunx rpxd init`,
  `cli-generators.md:32` uses `bunx @rpxd/cli init`. The package is
  `@rpxd/cli` with bin `rpxd` — `bunx rpxd` would resolve a *different* npm
  package named `rpxd`. Pick `bunx @rpxd/cli` (or publish an alias) and use it
  everywhere.
- **Kitchen-sink quickstart fails on a fresh clone.** `installation.md:15-21`
  and the root `README.md` omit `bun run setup` (prisma generate + db push);
  `adapters/db.ts` imports the generated client at boot, so `bun run dev`
  crashes. `examples/kitchen-sink.md:17` gets it right — align the other two.
- **`sse()` used without an import** in the `installation.md:100-112` config
  sample (`sse` is exported from `@rpxd/cli`). The sample doesn't compile as
  shown.

### 1.2 Code samples that don't typecheck

- **`ctx.tempId` is a method, not a property.** `first-live-object.md:75` and
  `optimistic-updates.md:35` write `{ id: ctx.tempId, ... }`; the ctx is
  `{ tempId(): string }` (`packages/core/src/live.ts:208`), and the kitchen-sink
  correctly calls `ctx.tempId()`. Fix both samples and the prose at
  `first-live-object.md:68`.
- **`ws()` imported from the wrong package.** `transports.md:26-28` imports
  `ws` from `@rpxd/server-bun`, which exports `wsTransport`; the `ws()` config
  helper lives in `@rpxd/cli` (`packages/cli/src/config.ts:33-35`).
- **`.load(loader, opts?)`** in `the-fluent-chain.md:69` — there is no second
  parameter (`live.ts:336`).

### 1.3 `wire-protocol.md` — normative doc, most drift

The page says "both implement exactly this and nothing more"; today it
describes a protocol that partially doesn't exist. Either fix the doc to match
the code or treat these as implementation TODOs — but decide per item:

- **W1** — the protocol-version handshake (client sends `v` on connect;
  mismatch → fatal `error` envelope) is not implemented anywhere; `v` only
  rides `RpcBatch` and is never checked (`instance.ts:223-228`).
- **W2** — there is no `attach` *control message*; SSR adoption is
  `?attach=<token>&seq=<n>` query params on the stream/WS URL
  (`handler.ts:689-690`). No control message carries `v`, and `resync` has no
  `seq` field (server pushes `full` unconditionally).
- **W3** — the `idMap` field comment says links are "resolved from server-side
  patch positions"; position matching is client-side only and never rides the
  wire — the wire `idMap` carries only `ctx.resolveId` results
  (`instance.ts:459-461`). Spec §4 is correct; the doc contradicts it.
- **W4** — `RpcBatch.calls` has no `tempIds` field (`protocol.ts:69-72`).
- **W5** — `full` is `{ state, session }`, not `unknown`; the envelope block
  omits the `redirect?: string` field the doc itself mentions later.
- **W6** — reconnect: the SSE URL (and attach seq) is fixed at connect time —
  `EventSource` re-sends the same URL; the server does no behind-comparison,
  it pushes `full` unless the exact token+seq adoption matches. Same wrong
  claim in `transports.md:44-47`. Spec §11 is closer to the code.
- **W7** — the terminal `error` status is unreachable: the client only ever
  sets `connecting/live/reconnecting`. Same claim in `transports.md:36-40`.
  (Decide: implement the terminal state or stop documenting it.)
- **W8** — `rpcId` is `c${counter}`, not a uuid (`store.ts:355`). Minor.
- **W9** — disconnect does *not* abort `ctx.signal` immediately; the abort
  happens at dispose/eviction after the warm TTL (`handler.ts:712-720`,
  `instance.ts:425-431`). Same claim in `transports.md:57-62` — and the ack is
  actually produced and cached for re-ack.

### 1.4 `kitchen-sink.md` — describes features the example doesn't have

- **K1** — "CSV import" (frontmatter): `routes/import.tsx` is a fixed 3-item
  loop; no CSV, no parsing.
- **K2** — the `/import` row claims "`onError` repair"; the route declares no
  `.onError` and has no failure path (it's `try/finally`).
- **K3** — the pages table omits `/item/$id` (`routes/item.$id.tsx`), the
  tier-2 soft-reload demo — arguably the most interesting routing behavior.
- **K4** — `/stream` says "`for await`"; it's a plain `for` over a static
  array. (`append` patches and `ctx.abort` are real.)
- **K5** — the `/account` row links to the *guard* anchor; the redirect is
  thrown in `setup` (deliberately — the docs elsewhere explain why). Link the
  right pattern.
- The shape tree omits `adapters/auth-client.ts`.

Either grow the example into what the doc describes (CSV parsing + an
`onError` demo would make `/import` genuinely instructive) or fix the doc.

### 1.5 Smaller factual drift

- `routes-and-auth.md:81-82` — stale parenthetical: the shipped example *is*
  Better Auth with async `auth.api.getSession`; the "sync `auth.getSession`"
  claim contradicts the doc's own opening.
- `cli-generators.md:9-12` — intro says generators never patch
  `prisma/schema.prisma`; the scaffold *appends* models to it (and the same
  page says so at lines 66-68). Reword the intro (correct for
  `rpxd.config.ts` / `package.json` only).
- `the-fluent-chain.md:130-139` render-props table — `sync` is
  `{ pending, inFlight, errors }` (not `{ pending, errors }`); the table omits
  the `status: ConnectionStatus` prop; `nav.navigate` is
  `(to, opts?: { params?, search? })`.
- `testing.md:161-163` — only `--kind page` scaffolds a `testLive` test;
  `--kind http` gets a plain domain test.
- `ssr.md:21-22` — an expired attach token does not "silently re-mount"; the
  server resyncs the still-warm instance with `full` (no
  `guard`/`setup`/`load` re-run).
- `persistence.md:13-14` — snapshot is `{ state, session, seq, version }` and
  the adapter also requires `delete`; the `session` field is what's restored
  on cold wake. (Spec §9 shares the omission.)
- `rsc.md` — `rsc()` returns an `RscField` marker `{ $rsc: string }`, not a
  bare string (also in `packages/rsc/README.md` and spec §16); "the todos
  example's `/doc` page" → the example is `kitchen-sink`.
- `async-handlers-streaming.md:14-16` — "`params`" listed as a queued
  mutation is a stale name (nothing called params is queued; likely URL loads).
- `spec.md` §17 monorepo tree omits `packages/rsc` and `packages/testing`;
  §4 still asserts a custom Biome rule that doesn't exist (CLAUDE.md already
  records it as deferred — update the spec text to match).
- `adapter-node/README.md` "~130 lines" → file is 236 lines. Trivial.

---

## 2. Coverage gaps — the "can I ship it?" axis

The docs answer "how does it work?" superbly and "can I run it in
production?" almost not at all. For a framework whose adoption pitch includes
*server-side* state, this is the highest-leverage area. Prioritized:

1. **Deploying to production** (new guide). `rpxd build`/`start` get two table
   rows today. Needed: reverse-proxy requirements for long-lived SSE/WS
   (buffering off, read timeouts), the `RPXD_SESSION_SECRET` + Secure-cookie
   deploy checklist (currently buried in routes-and-auth), static assets,
   choosing a storage adapter for durability, `PORT`/`StartOptions`.
2. **Running on Node.** `@rpxd/adapter-node` (Node ≥ 24, plus
   `@rpxd/storage-sqlite/node`) is never mentioned on the site;
   `installation.md` flatly says "rpxd runs on Bun." `startApp` already
   auto-selects the adapter. One section widens the addressable audience
   substantially.
3. **Scaling & multi-node** (new guide or expanded concepts page). "Any node
   can host any session — no sticky sessions" is one of the framework's
   strongest operational advantages and today it's five sentences at the
   bottom of pubsub.md. Cover: Redis for both snapshots *and* the bus, the
   in-process-throttle caveat (rate-limit at the edge), LB guidance, the
   `RedisLikeClient` duck-type / `prefix` option / publish-failure behavior.
4. **Error handling** (new guide). The full story exists only in fragments:
   rpc promises reject in the browser (documented only in the *testing*
   guide), `sync.errors`, `.onError()` repair, load errors-as-state,
   `__error`, `debugErrors` dev/prod disclosure, and how rate-limited rpcs
   surface (`RateLimitError` → rejection + `sync.errors`; 429 on HTTP).
   Also an API gap worth flagging: `LiveStore.clearErrors()` exists but isn't
   reachable from render props — there's no way to dismiss `sync.errors` in a
   component.
5. **Security page** (consolidation). The origin policy, cookie signing, and
   throttle content in routes-and-auth is excellent but scattered — evaluators
   look for a single security page. Add the undocumented pieces:
   `onSecurityEvent` / `SecurityEvent` taxonomy (`origin-rejected`,
   `rate-limited`, `cap-evicted`, `cap-rejected`), the spoofable
   `X-Forwarded-For` warning, and the WS post-upgrade throttle blind spot.
6. **Capacity & eviction tuning.** `RpxdHandlerOptions` has well-TSDoc'd knobs
   (`warmTtlMs`, `attachTtlMs`, `unattachedTtlMs`, `maxUnattachedInstances`,
   `maxInstancesPerSession`) that appear nowhere in prose — and are not
   exposed through `RpxdConfig`/the CLI at all, so CLI users can't set them.
   That's a config-surface gap as much as a docs gap.
7. **Adding rpxd to an existing app / custom servers.** The `rpxd()` Vite
   plugin, `createRpxdHandler`, `ServerAdapter`, `bunAdapter`, and the client
   runtime (`LiveApp`, `RpxdProvider`, `LiveConnection`, injectable
   `fetchImpl`/`eventSource`/`webSocket`) are all public with zero prose
   mentions — the moment someone leaves the zero-config path there's nothing.
8. **App shell & error pages.** `__root` / `__404` / `__error` appear only as
   file-tree comments; no page says what props they receive or how they relate
   to `render`/`renderError`/`renderNotFound`. The kitchen-sink has working
   examples to lift.
9. **"What can live in state."** Nothing states the serializability
   constraint — state crosses the wire as JSON patches and is snapshotted
   whole, so Dates/Maps/Sets/class instances need an answer (especially since
   the scaffold's `datetime` field maps to TS `Date`).
10. **Reconnection semantics.** transports.md covers the happy path; WS
    retry/backoff, what an app should do about a dead connection, and
    `ConnectionOptions.onRedirect`/`base` are uncovered. Realtime frameworks
    get evaluated hard on exactly this.
11. **Surface the ADRs.** `docs/adr/0001` answers "why is there no
    `.atomic()`/transaction API?" — the first question an experienced dev
    asks — but the site never links it. A "design decisions" note in
    async-handlers-streaming.md and ssr.md (or links from concepts) is cheap.
12. **`session()` adapter's `ttlMs`** (default 30 min) — undocumented; the
    persistence table row doesn't say what distinguishes it from `memory()`.

---

## 3. Audience & positioning

The audience arrives with priors from React Query + tRPC, Next.js, Phoenix
LiveView, and Convex/Liveblocks/PartyKit. Recommendations:

- **Add a comparison/positioning page** ("How rpxd compares"): vs
  LiveView (same server-state instinct, but real React + optimistic replay),
  vs React Query + tRPC (no query-key/cache layer — the URL is the query key),
  vs Convex/Liveblocks (your own database; the framework never touches it).
  The introduction's "What makes it different" bullets are good raw material;
  an evaluator-facing comparison anchors the mental model faster than any
  amount of concept prose.
- **Put code on the landing page.** `index.mdx` has hero + four cards and no
  code; the root README's 20-line board example is the best pitch the project
  has. Landing pages for frameworks are judged by the first code block.
- **State the project's maturity.** Nothing says alpha/beta/pre-1.0, and the
  packages are unpublished. Evaluators need this before anything else; an
  honest status banner builds more trust than silence.
- **Stop leaking spec-section references.** 27 bare `§n` references across 7
  user-facing pages (e.g. testing.md's handle table, "(§12)" in guides).
  Readers can't resolve `§12` without opening `spec.md`. Replace with links to
  the friendly page (or drop them); keep §-refs inside `spec.md` and READMEs.
- **Sell the advantages where they're proven, not just claimed.** Three
  genuinely differentiating properties are documented but under-lit:
  - *No sticky sessions / any node hosts any session* — buried at the bottom
    of pubsub.md (see gap 3).
  - *O(delta) token streaming via `append`* — great in
    async-handlers-streaming.md; deserves a landing-page card with the
    two-line `s.answer += delta` sample (the LLM-app audience is exactly who's
    evaluating this in 2026).
  - *Free rollback by replay* — optimistic-updates.md explains it well;
    the landing card could show the "errors just drop the function" one-liner.
- **A "limitations" section** (or per-page callouts in the style of the
  infinite-scroll caveat): memory per warm session, whole-state snapshot
  write-through, per-session instances (multiplayer costs a broadcast), no
  offline story. The docs' honest voice is a strength — extend it to the
  system level.

## 4. Structure & navigation

- **Reorder the guides.** "Loading data" (order 8) calls itself "the
  foundation every pattern in the next few guides builds on" but sits after
  CLI generators; "Async handlers & streaming" (2) is advanced material placed
  before the basics. Suggested order: fluent chain → loading data → optimistic
  updates → routing → pagination/infinite-scroll/filtering → async/streaming →
  domain layer → routes & auth → CLI generators → testing.
- **Concepts should not open with the wire protocol.** It's the most internal
  page; lead with request-lifecycle and put wire-protocol last as the spec
  mirror.
- **A "Production" or "Operations" sidebar group** gives gaps 1–6 above a home
  and signals to evaluators that shipping is a first-class concern.

## Priority shortlist

1. Fix the getting-started path (1.1, 1.2) — broken quickstart + non-compiling
   samples cost adopters in the first five minutes.
2. Reconcile `wire-protocol.md` with the implementation (1.3) — a normative
   doc that's wrong is worse than no doc; decide fix-doc vs fix-code per item.
3. Write the deployment + Node + scaling docs (2.1–2.3) — the biggest
   adoption blocker and partly a marketing opportunity (no sticky sessions).
4. Fix kitchen-sink.md or grow the example to match it (1.4).
5. Error-handling guide + security consolidation (2.4, 2.5).
6. Positioning: comparison page, landing-page code, status banner, de-§-ify
   (section 3).
