# ADR 0002 — Live slots: everything is live

- Status: accepted — **implemented** (all 16 items landed on
  `claude/nested-live-components-8b0voi`; two review rounds, final verdict
  clean)
- Date: 2026-07-15

## Post-implementation follow-ups (non-blocking, from the final review)

- ~~`packages/vite-plugin/src/strip.ts` — **parameter decorators** are a
  remaining false-shadow corner of the import pruner (requires legacy
  `experimentalDecorators`, a kept render, and a parameter named after an
  import used only in stripped code — probe-confirmed but vanishingly rare).
  Fix direction: carry a passed-through-a-Decorator flag up past the
  decorated declaration in `isShadowedLocally`.~~ **Resolved:**
  `isShadowedLocally` now carries a `skipEnclosingFunctionScope` flag past a
  decorated parameter so parameter-decorator references resolve against the
  enclosing scope; regression test added to `strip.test.ts`.
- ~~`LiveConnection.mount` (static, cold no-SSR mount; zero production callers
  today) — add a TSDoc sentence noting schema'd routes should pass decoded
  props; a raw-string cold mount of a schema'd route fails loudly (422), not
  silently.~~ **Resolved:** TSDoc note added (pass JSON-typed decoded props +
  `hasPropsSchema` via `opts`); the `search` param was also renamed to `props`.

## Context

Spec §13 deferred "nested/sibling live objects + layouts" as requiring nested
live semantics. Design review found the deferral was overpriced: the wire
protocol and control plane were built multi-instance from day one (envelopes
are instance-tagged; `subscribeSession` joins every session instance to each
stream; `mount`/`release`/`resync` are per-instance), so composition is
reachable without new protocol machinery. The review also surfaced a driving
use case: **agent-first apps** — a persistent chat panel that survives
navigation while pages come and go.

The design converged through successive *deletions*: a separate `live.slot()`
entry, a second "view" schema, an opaque id string, leading-slash
discrimination, a `slots/` directory, and a `props` wire field were each
proposed and then removed because an existing invariant already covered the
job. That convergence pattern — requirements absorbed by shrinking, not by
adding — is the primary evidence this feature is latent in the architecture
rather than bolted on.

## Decision 1 — One declaration: `live(pattern, propsSchema?)`

**Options considered**

- **A.** A separate `live.slot(idPattern, schema)` entry beside `live(path)`.
- **B.** Zod-object identity (`live(z.object({...}))`) with canonical-JSON
  instance keys.
- **C.** One `live(pattern, propsSchema?)` for every live object; the pattern
  reuses page `$param` syntax and the existing `PathParams` inference.

**Chosen: C.** A and B each fork vocabulary or keying. C reuses `PathParams`,
`matchRoute`, `buildHref` segment-fill, and the `${sid}:${key}` keyspace
verbatim. The pattern-filled string is the instance key; no canonicalization
mechanism exists because none is needed.

**Identity vs props.** Pattern params are identity: a change remounts
(`setup` reruns). The schema types `props` — one patchable record: a change
reruns `guard`+`load` on the same instance, state preserved. `setup`'s ctx
exposes `params` only (never props), making "skeleton baked from a patchable
value" structurally impossible — the same enforcement pages get from
receiving `params` and not `search`. This is the Phoenix LiveView
`mount`/`handle_params` split, steered per callsite by which values the
parent puts in the pattern.

**Rename.** `search` → `props` everywhere (public API, wire field, docs). A
page's URL query *is* its props record: one JSON value model, two encodings
(URL query string ↔ control-plane JSON body). The URL codec is
per-value try-`JSON.parse`, fall back to raw string (TanStack Router
precedent); applied **only when a schema is declared** — schema-less routes
keep raw strings (back-compat). This closes §13's "typed search params"
deferral as a side effect.

## Decision 2 — Addressability is registration, not declaration

**Options considered**

- **A.** Leading `/` = URL-addressable, slash-free = prop-addressed.
- **B.** Location decides: files in `routes/` are router-served; *any*
  exported `live()` object anywhere is mount-registered; the control-plane
  mount matches the **union** of both tables.

**Chosen: B.** The object carries no addressability flag. Pages are mountable
as slots by construction (same table entry, same guard, same key — a slotted
page **shares its instance** with a routed copy in the same session, which is
already the two-tabs semantics). Pattern uniqueness across the union becomes
the load-bearing invariant: same-pattern-same-object is instance sharing;
same-pattern-different-objects is a build error (and a boot-time assert).

## Decision 3 — Discovery: syntactic `tsc` scan; strip transform for clients

**Options considered for discovery**

- **A.** Regex over source (the `PATH_CALL` approach).
- **B.** Glob + import + inspect `mod.default.$live` (execution).
- **C.** Syntactic parse with the `typescript` package — `ts.createSourceFile`
  per file, no `Program`, no type-checker; resolve the default export's call
  chain to an identifier bound by `import { live } from "@rpxd/core"`; read
  the pattern `StringLiteral`.

**Chosen: C.** A has false positives and cannot resolve indirection; B
executes server-only top-level side effects (db connections) at codegen time.
C is low-ms per file with zero new dependencies (`tsc` is already in every
app's toolchain), and its literal spans retire the `PATH_CALL`/`UNSPLICEABLE`
regex machinery in `ensurePathLiteral`. Unexported `live()` calls, non-literal
patterns, and duplicate patterns are build errors. Generated importers assert
`$live: true` at boot (scan false-positives fail at startup, not first
mount). An additive `slots: [...]` config list covers library-shipped live
objects the file scan cannot see.

**Strip transform.** Client builds must strip server-only chain steps
(`setup`/`guard`/`load`/`on` handlers, rpc `handler`/`onError`) and the
imports only they use from registered live modules, keeping `input` schemas,
`optimistic` fns, the pattern/props schema, and `render`. This fixes a
**pre-existing** exposure (page loader bodies and their import graphs are
reachable from the client bundle today) and is mandatory before slots,
because `<LiveSlot of={X}>` statically imports live modules into page
components. Dev-mode requires the transform to prune orphaned imports itself
(no build-time treeshake in dev). Stubs are a named `__rpxdServerStub` that
throws, so logic errors are loud.

## Decision 4 — Patch by default; warm mounts re-guard always, re-load on change

Warm reuse previously reran `guard`+`load` unconditionally, so a second tab
on a slot-bearing page re-executed every slot's load. New rule: **always**
rerun `guard` (authorization freshness is never weakened), **skip `load`**
when incoming props are deep-equal (canonical serialized form) to the
entry's last-reconciled props *and* the instance is live. Snapshot-restored
(cold-wake) instances still reconcile fully (§9's staleness argument applies
only there).

## Decision 5 — Persistence is position + a connection that outlives pages

**Options considered**

- **A.** Nested route semantics (path-prefix identity, lifecycle trees).
- **B.** Persistence falls out of existing machinery: (i) server instances
  persist via warm reuse when identity is unchanged; (ii) the **connection
  becomes app-lifetime** — tier-3 navigation mounts the new page instance
  over the same multiplexed stream (tier 3 = tier 2 + component swap;
  `performNavigation`'s two branches collapse to one; rpc meta moves
  per-store); (iii) a new optional **`__layout.tsx`** shell file renders
  inside `RpxdProvider` but outside `key={pathname}` — static React that may
  host `<LiveSlot>`s, mounted once per app session, surviving all tiers.

**Chosen: B.** A layout is **static React hosting live slots** — it is not a
live object and has no lifecycle semantics; persistence comes from *where* it
renders. A "live layout" is simply a slot in the layout. With B, an agent
chat panel survives navigation at all three layers: instance (warm reuse —
never released, since a layout slot never unmounts), transport (app-lifetime
connection), and React tree (layout region) — streaming tokens keep painting
into the same DOM nodes across navigation.

## Decision 6 — Economics: the cap is doctrine enforcement

**Options considered**

- **A.** Raise `maxInstancesPerSession` (32 → 128) to accommodate slot-heavy
  pages.
- **B.** Keep 32. Add a **soft byte budget** (`maxSessionStateBytes`,
  measured at the write-through where state is already serialized; over
  budget → diagnostic + refuse *new* mounts + shed idle harder — never reject
  a flush or evict a subscribed instance) and a **mount throttle** (token
  bucket on `mount`/`mount-batch`).

**Chosen: B.** Counts cap structure (per-instance overhead, fan-out
membership — a thousand tiny instances is an attack bytes can't see); bytes
cap substance (one ballooning instance is an attack counts can't see);
the throttle caps storms. A tight count default makes the list antipattern
fail fast in development. Two-stage legibility: a dev diagnostic
(`slot-fanout-high`) fires at ~10 slots per batch — several steps before the
wall at 32 — and the `SessionCapError` diagnostic carries doctrine wording.
`opts.maxInstancesPerSession` stays configurable as the explicit escape hatch.

## Doctrine — aggregates, not rows

A live object owns an **aggregate**, not a row. Reach for a slot when a thing
has its own *lifecycle* (own rpcs, own subscriptions, own multiplayer scope) —
not its own *data*. If you are calling `.map()` to render `<LiveSlot>`s, the
collection wants to be one live object. Sibling slogan to §6's "chatty client
= missing reducer": **a list of slots = a missing aggregate.** Both push
toward fewer, richer live objects. Cross-instance coordination is the server
bus (`ctx.broadcast`/`.on`) — state-bearing events go through the server
(multiplayer-correct by construction); view-only coordination is plain React.
There is **no** cross-instance optimism (pending queues, tempIds, `keyOf` are
per store) — deliberate.

## Out of scope (unchanged deferrals)

- **SSR for slots** — slots client-mount post-hydration and render `fallback`
  until `load`'s first patch. Render-driven SSR discovery (server mounts
  slots encountered during the page render; multiple bootstraps) is the
  known follow-up with a clear payoff (kills first-load client RTTs).
- **Cross-instance optimistic updates.**
- **Runtime-federated microfrontends** (separate rpxd apps in one page): the
  seams exist (`ConnectionOptions.base`, storage-adapter bus), the costs are
  documented (one stream per origin, auth across origins, version skew);
  build-time composition is the supported tier.
- **Server-side cross-instance rpc dispatch** (`ctx.invoke`) for agent tool
  execution — see "Future direction" below.

## Stop-signals (abort conditions, decided while calm)

1. If item 6 cannot be built by **parameterizing** `mountInstance`/
   `reconcileUrl` and needs a fork, the "one lifecycle, two address spaces"
   claim is false in practice — back to the bench.
2. If item 5's dev-mode import pruning swamps its budget (HMR instability,
   sourcemap breakage), decouple it: ship as pages-only hardening on its own
   timeline; gate only the kitchen-sink slot examples on it.
3. If item 16's acceptance specs need slot-specific server workarounds, the
   semantics are not actually unified. The suite is the arbiter.

## Implementation plan

Conventions for every item: TDD (failing test first); TSDoc + `@example` on
new public APIs (`bun scripts/check-tsdoc.ts`); wire-touching items (1, 6, 7,
11) update `wire-protocol.md` + `protocol-conformance.test.ts` in the same
change; diagnostics via injected `emit`, never `console.*` (browser client
excepted); feature branches, merge on green. Groups — **1–3** core fold;
**4–5** build tooling (5 ships regardless of slots); **6–8** server control
plane; **9–11** client vertical; **12–13** persistence; **14** economics;
**15–16** harness + acceptance. Each group is a valuable terminal state:
1–3 ships typed search params; 4–5 ships the client-bundle security fix;
6–11 ships working slots; 12+ ships layouts and the gate. 1–3 serial; 4–5
start once 2 lands; 6–8 and 9–11 are parallel tracks against hand-built
registrations until 4 merges; 12–16 close serially.

### 1. Mechanical rename: `search` → `props`, zero behavior change

Public API, wire field (`{ type: "url", instance, props }`), and docs; keep
`type: "url"`. Helpers genuinely parsing `window.location.search`
(`searchOnlyChange`) may keep URL vocabulary. Files: `core/live.ts`
(`SearchParams` → `PropsRecord`, `Url` → `{ params, props }`),
`core/instance.ts`, `client/connection.ts` (`patchSearch` → `patchProps`),
`server-bun/handler.ts`, `testing/index.ts`, `spec.md` §1/§7, contract
triple. **TDD:** full suite green post-rename; conformance pins the new field
and adds a negative assertion on the old. Pre-1.0: no compat shim; changelog
note.

### 2. The fold: `live(pattern, propsSchema?)` in core

Second arg is a Standard Schema typing the props record; no addressability
flag; builder asserts `pattern.startsWith("/")` and rejects non-literal
patterns in dev. `LiveRoute` gains `props?`; `LiveInstance` never sees it.
Files: `core/live.ts`, `core/index.ts`. **TDD:** `live.test-d.ts` — loader
arg `{ params, props }` fully typed; unknown props key = compile error;
schema-less routes keep `PropsRecord`; `setup` ctx exposes `params`, never
`props`. Runtime: schema on the object; `live("card/$id")` throws.

### 3. The props codec

`decodeProps`/`encodeProps` in new `core/props-codec.ts`: per-value
try-`JSON.parse`, fall back to raw string; inverse on write; applied only
when a schema is declared. Adapter calls it on the page GET path (decode →
`validateInput`, awaited — Standard Schema may be async). **TDD:** property
test `decodeProps(encodeProps(x))` ≡ `x`; quoted-string ambiguity pinned
(`{ v: "20" }` → `v=%2220%22`); `?limit=20` reaches `load` as number `20`;
`?limit=abc` rejects; regression: schema-less `?filter=done` stays a string.
Update spec §7/§13 (typed search params land here).

### 4. Discovery: `tsc`-based scan for exported `live()` objects

`scanLiveModules` (new `vite-plugin/scan.ts`): `ts.createSourceFile` per
file (syntactic only), whole tree minus `node_modules`, `.rpxd`,
`**/test/**`, `**/*.test.*`, `**/test-bun/**`; resolves
`const x = live(...); export default x` indirection; emits
`.rpxd/live.gen.ts` (lazy importers keyed by pattern —
`generateHandlersModule` precedent). Errors: unexported live object;
non-literal pattern; duplicate pattern across routes ∪ tree (names both
files). `ensurePathLiteral` moves to AST-span splicing (retires `PATH_CALL` /
`UNSPLICEABLE`). Importers assert `$live: true` at boot. `slots: [...]`
config escape hatch for library modules. **TDD:** fixtures for each error and
the indirection case; `live(` in comments/strings ignored; regression:
`routes.gen.ts` byte-identical for a slot-free project.

### 5. Client-build strip: server chain steps never reach the browser

Vite `transform` hook (`!ssr` + module in item-4 registration set): AST-stub
`.setup`/`.guard`/`.load`/`.on` handlers and rpc `.handler`/`.onError` args
with a throwing `__rpxdServerStub`; keep `.input`/`.optimistic`/pattern/props
schema/`.render`; then prune orphaned imports **in the transform output**
(dev has no treeshake). New `vite-plugin/strip.ts`. **TDD:** `node:fs` used
only in `load` → absent from client output; `ssr: true` untouched;
`rpcMetaFromDef` still works on transformed modules; sourcemaps point at the
original chain; §15 reducer-HMR preserves state across edits; no client path
calls `def.setup` (asserted). Integration: canary string in a `load` body
appears in zero kitchen-sink `dist/` assets; dev server survives
`bun:sqlite` in a loader's import graph.

### 6. Server: union-table mounts over the control plane

`{ type: "mount", path, props, stream }` matches routes ∪ registered
modules via one `matchRoute`; props validated **before** `guard` (untrusted);
then the existing `mountInstance` → `buildInstance` path **parameterized by
registration** (fork = stop-signal). Boot-time duplicate-pattern assert.
**TDD:** valid mount → instance + snapshot on the joined stream; invalid
props → 422, `instanceCount === 0`, no `setup` ran; guard deny →
`{ redirect }`, nothing allocated; routed page mounted via control plane →
**same** `entry.instance.id` (shared instance pinned as a feature);
mount-only pattern via browser GET → 404; `shedIdleInstances` never sheds a
subscribed slot; regression: tier-2 `remount` byte-identical.

### 7. Server: props patch — validated tier-1 reconcile

The `url` message (HTTP + WS mirror) validates against the def's schema when
present, then `reconcileUrl` (supersede-aware). **TDD:** patch → `load`
reruns, prior state survives until overwritten; guard runs once per patch;
invalid props → 422, no `load`; rapid patches → latest wins; regression:
schema-less `nav.patch` unchanged.

### 8. Warm-mount dedup: re-guard always, re-load only on change

`InstanceEntry.lastProps` (canonical serialization) written on every
successful reconcile; warm mount/patch **always** reruns `guard`, skips
`load` when props are deep-equal and the instance is live (cold-wake still
reconciles fully). **TDD (failing-first confirms the tab storm):** identical
props → guard +1, load +0; changed props → both; snapshot-restored + identical
props → load runs; deny on the skipped path still redirects.

### 9. Client multiplexing + the app-lifetime connection

`LiveConnection` holds `#stores: Map<instance, LiveStore>`; envelopes route
by `env.instance`; reconnect fans `resendUnacked()`/status to every store;
`#denySinks` consulted before the page-instance redirect check. New
`mountSlot(path, props, meta)` → `SlotHandle { store, patchProps, release,
onDeny }`. **Rpc meta moves per-store** (mount paths carry
`rpcMetaFromDef`). **Tier 3 rides the same connection**: mount the new page
instance over the existing stream, swap the primary store, release the old —
`performNavigation`'s two branches collapse; `LiveApp` never closes the
connection on navigation. **TDD:** envelopes never cross stores; reconnect
resends from page and slot stores; slot deny doesn't soft-nav the app;
tier-3 nav → zero new `EventSource` constructions (factory spy) and slot
stores keep receiving envelopes *during* the navigation; slow-consumer kill →
reconnect resyncs **every** store cleanly (app-wide blast radius test);
regression: single-store remount suite unchanged.

### 10. `<LiveSlot>` component (+ identity-flap detection)

`<LiveSlot of={X} params props fallback onDeny />` — identity string via
`fillPattern` (extracted from `buildHref`, no leading-slash assumption);
mount on effect keyed `[conn, id]`; prop diffs coalesced per microtask
(serialized comparison); identity change → release + mount with per-slot
supersede (stale mount releases itself); unmount → release; renders
`state`/`rpc`/`sync`/`keyOf`/`status` — no `nav`. Dev guard: > K remounts/sec
at one position → `console.error` naming the unstable param. New
`client/slot.tsx`. **TDD:** StrictMode double-invoke → one mount; three
same-tick prop changes → one `patchProps`; identity change → ordered
release/mount; deny → `onDeny` + `fallback`; flap detector fires once in dev.

### 11. Batched mounts (+ fan-out doctrine diagnostic)

Same-tick `mountSlot` calls coalesce into `{ type: "mount-batch", mounts }`;
server `Promise.all`s the item-6 path per entry, answers positionally (one
failure never poisons the batch). Dev diagnostic `slot-fanout-high` at > ~10
mounts per batch, gated on `isDev()` (never `isProd`), doctrine-worded,
linking "Aggregates, not rows". **TDD:** 5 slots → one POST; mixed
deny/success settles independently; 30-mount dev batch → one diagnostic,
none in prod; regression: single mounts unbatched.

### 12. Release/mount pair cancellation (slot survival race)

The item-11 queue cancels same-identity release+mount pairs before the wire
(React remounts across page swaps become no-ops) — **but a cancelled pair
whose props differ must still forward a `patchProps`**, or a slot shared
across pages keeps the previous page's props (a stale-capability bug: e.g. a
chat slot keeping the old page's tools). Across ticks, release then mount,
ordered. **TDD (failing-first):** same-tick unmount+remount, same props →
zero control messages, store rebinds to same instance id; same-tick
unmount+remount, **changed props** → zero mount/release but exactly one
`url` props patch, and `load` reruns with the new props (item 8); server
mount/release/re-mount → same `entry.instance.id`, `setup` once, pre-nav
state in the resync snapshot.

### 13. `__layout.tsx` — the persistent region

New optional shell file: rendered by `LiveApp` inside `RpxdProvider`,
**outside** `key={current.pathname}` — mounted once per app session,
surviving all tiers; static React that may host `<LiveSlot>`s and use
`useNav`. `fileToRoute` gains kind `"layout"`; codegen emits `layoutModule`;
SSR composes the layout around the page (slots SSR as `fallback`; verify the
existing root/page SSR composition first — hydration-mismatch check).
**TDD:** layout renders once across tier-1/2/3 (mount-count spy); a layout
slot's controlled-input draft survives tier-3; `__root` stays
document-chrome-only.

### 14. Session economics

`maxInstancesPerSession` **stays 32** (doctrine backstop; configurable
escape hatch). Add `maxSessionStateBytes` measured at the write-through
(state is already serialized there): over budget → security diagnostic +
refuse new mounts + shed idle harder; never reject a flush or evict a
subscribed instance. Add per-session token bucket on `mount`/`mount-batch`
(existing `throttleBuckets` machinery) → storms degrade to 429 → `fallback`.
`SessionCapError` gets a specific, doctrine-worded diagnostic type. **TDD:**
at budget → new mount refused, existing instances' rpcs unaffected; freed by
eviction → mounts resume; mount flood → 429s, existing instances unaffected;
regression: slot-free defaults unchanged.

### 15. `testLive` props support

`testLive(AnyLiveObject, { params, props })` + `t.patchProps(next)`
(validate → reconcile), mirroring `t.navigate`; `TestRpcFacade` unchanged.
**TDD:** mount-only fixture drives typed `t.rpc.*`; `patchProps` reruns
`load`, `t.settled()` awaits; invalid props reject before `load`; regression:
page fixtures unchanged.

### 16. Kitchen-sink dashboard + Playwright acceptance

The demo becomes a **dashboard**: persistent chat panel (`__layout.tsx`
slot — own bus topic, own rpcs, optimistic sends, streaming, multiplayer);
the RHS is the routed app. One browsable view embeds the board *page* as a
slot (union payoff, honest scale); a "featured item" slot demonstrates
data-dependent identity without rows-as-slots. The message list *inside*
chat stays plain state (the doctrine's negative case, on screen). Specs:
chat survives tier-1/2/3 with a local draft + a pending optimistic message
(the three-layer persistence gate); second tab → **zero** extra loads
(item 8, via a domain-layer load counter); page rpc broadcast → chat `.on`
notification (cross-object bus, exclude-self honored); cross-context
multiplayer; slotted page mutation visible in a second tab routed to the
same URL (shared instance); guard-denied slot → `fallback`, dashboard stays
live; cap rejection → `fallback` + doctrine diagnostic; `?limit=20` reads as
number `20`; item-5 canary in zero `dist/` assets; regression: existing
SSR-attach/reconnect/optimistic specs green. **Docs (rides this item):**
"Aggregates, not rows" concepts page (docs style guide), with the dashboard
as its worked example; both diagnostics link to it by name.

## Open question (discussion only — nothing decided): agent tools follow navigation

The dashboard shape points at agent-first apps: a stable chat slot shared
across pages, whose available tools change as the user navigates. Tool
*availability* appears expressible with this ADR's machinery as-is (tools
flow as slot props; navigation is a props patch — the discussion that
surfaced item 12's changed-props amendment). How an agent *executes* page
functionality server-side is an open design question with several candidate
shapes and is **deliberately undecided** — it gets its own ADR when a
concrete prototype makes the trade-offs real. Nothing in this ADR's plan
forecloses it.
