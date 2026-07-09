---
name: numbered-plan
description: >-
  Present an implementation plan in the repo's dense, implementer-ready
  "numbered plan" format. Use this whenever the user asks for a "numbered
  plan", "sequenced plan", asks to "sequence this into a plan", "number the
  plan", or otherwise wants a prioritised, TDD-first, per-item breakdown ready
  to hand to an implementer.
---

# Numbered plan format

When the user asks for a **numbered plan** or **sequenced plan**, present the
plan in the exact structure below. This format is dense and implementer-ready:
every item is independently landable, TDD-first, architecturally placed, and
carries the concrete code sketch + tests needed to execute it.

Do the analysis and exploration first — read the code, find the real symbols,
file paths, and line numbers. The plan is the *output*: it must reference real
identifiers, not placeholders.

## Structure

1. **Title line:** `## The numbered plan`

2. **Preamble paragraph** (no heading, directly under the title). Two jobs:
   - State the conventions that apply to *every* item, once, so they aren't
     repeated per item — e.g. "All items: TDD (failing test first), base on
     `main` after #72 merges, secure-by-default with the one explicit opt-out
     noted."
   - Give a **priority/grouping map** of the items — e.g. "Items 1–2 are
     correctness/leak fixes (highest priority); 3–4 cookie integrity; 5–8
     quotas/hardening." Order items by priority.

3. **Each item**, in priority order:

   `### N. <Short imperative title> (<provenance tag>)`

   The provenance tag is optional and goes in parentheses in the title: an
   issue ref (`#61 follow-up`), a reorder note (`was point 8`), or a label id
   (`B1`). Include it whenever the item traces to a ticket, a prior plan
   position, or a tagged bucket.

   Then a stack of **bold-labelled sub-sections** (label in bold, colon or
   em-dash, then prose):

   - `**Goal:**` — one sentence: the intent and why. Note explicit trade-offs
     inline (e.g. "no config, no opt-out (strictly-better cleanup)").
   - `**Architecture:**` — where the item sits and how it composes. State which
     layer(s) it touches and confirm it respects rpxd's boundaries:
     - **App/userland axis** (`examples/*`, and what the docs recommend for
       app code): `routes/` (the edge — thin orchestration) → `domain/`
       (bounded modules, the app's public API, the only layer that touches the
       db) → `adapters/` (server-only clients: db, auth). The one rule: routes
       call `domain/`, never `db`; dependency direction is one-way.
     - **Framework/package axis** (work inside `packages/*`): `core` (the
       runtime domain — `live()`, queue, patches, pubsub, the storage seam) →
       adapter seams (`server-bun`, `storage-*`) → verticals that cut across
       (`client`, `vite-plugin`, and the end-to-end slice through
       `examples/kitchen-sink`). Adapters depend on `core`, never the reverse;
       platform types (Bun, `bun:sqlite`) stay inside `bunAdapter` /
       `storage-sqlite` and never leak into `core`.

     Name whether the item is a **domain** change, an **adapter/seam** change,
     or a **vertical** slice, and call out any boundary it must not cross.
   - `**Files:**` — the affected paths in backticks, with the touched symbol in
     parens where useful: `` `handler.ts` (`mountInstance`) ``.
   - `**Sketch —**` — a sentence locating the change, then a fenced code block
     (```ts) showing the actual edit. The sketch is real code, not
     pseudocode; a fragment is fine.
   - `**TDD:**` — the failing test(s) to write first, with concrete assertions
     (what getter/spy, what value it must reach). Fold regression coverage in
     with an inline `**regression:**` clause.
   - `**Implementer notes / risk:**` — caveats, behaviour-sensitive bits,
     things to confirm before coding. Include only when there's a real risk.
   - Extra labels as needed for the item, same bold-label style — e.g.
     `**Scaffolder:**` for template/codegen updates.

   Omit a sub-section only when it genuinely doesn't apply. Goal, Architecture,
   Files, and TDD are effectively always present (this repo is TDD-first and
   layered).

## House style (match this exactly)

- **Backticks on everything mechanical:** every identifier, file path, symbol,
  type, and value goes in backticks — `scheduleEvictionIfIdle`,
  `packages/core/src/instance.ts`, `instanceCount === 0`.
- **Line references** as `file.ts:290`, and traces with arrows:
  `handler.ts:290 create → :299 reconcile-throws → :301 register-never-reached`.
- **Dense prose:** em-dashes for asides, semicolons to chain related clauses,
  no filler. Terse but complete.
- **Priority ordering:** highest-impact/correctness items first; hardening
  later. The preamble's grouping map must match the actual order.
- **Architectural honesty:** every item's `Architecture:` line places it on the
  right layer and respects the one-way dependency direction (routes → domain →
  adapters; adapters → `core`, never `core` → adapter). Flag cross-layer items
  explicitly and keep platform types behind their seam.
- **TDD-first, always:** each item's `TDD:` describes a test that fails before
  the change and passes after. Never present an item without its test.
- **Every item independently landable:** one item = one focused, mergeable
  change.

## Example

> **User:** Give me a numbered plan for closing the eviction leaks.

## The numbered plan

Notes for the implementer are inline. All items: TDD (failing test first), base
on `main` after #72 merges, secure-by-default with the one explicit opt-out
noted. Items 1–2 are correctness/leak fixes (highest priority); 3–4 cookie
integrity; 5–8 quotas/hardening.

### 1. Close the residual anonymous-traffic leaks (#61 follow-up)

**Goal:** two eviction-path fixes; no config, no opt-out (strictly-better
cleanup).

**Architecture:** adapter-internal — lives entirely in the `server-bun`
runtime's instance-registry bookkeeping. Touches no `core` public API and no
userland `domain/`; persistence goes through the `storage` seam
(`storage.delete`), never a concrete adapter. Pure lifecycle hygiene at the
adapter layer.

**Files:** `packages/server-bun/src/handler.ts`.

**Sketch —** in the `scheduleEvictionIfIdle` timer body, and mirror the
empty-map prune in `enforceUnattachedCap` + the session-changed branch:

```ts
entry.evictTimer = setTimeout(() => {
  if (entry.instance.subscriberCount > 0) return;
  const m = sessions.get(sid);
  m?.delete(key);
  if (m && m.size === 0) sessions.delete(sid);
  byInstanceId.delete(entry.instance.id);
  unattached.delete(entry);
  if (entry.everAttached) {
    void entry.instance.dispose();
  } else {
    void entry.instance.dispose(false)
      .then(() => storage.delete(`${sid}:${key}`));
  }
}, graceMs);
```

**TDD:** add a `sessionCount` introspection getter (like `instanceCount`);
assert it returns to `0` after N cookieless mints evict; storage spy shows
`delete` (not persist) on unattached evict; **regression:** an *attached*
instance still snapshots on warm evict.

### 2. Guard before setup + dispose-on-throw leak fix (was point 8)

**Goal:** fix the confirmed leak — a guard-denied or load-throwing mount
currently orphans a setup-initialized instance (live pubsub subscriptions,
never disposed; verified at `handler.ts:290` create → `:299` reconcile-throws →
`:301` register-never-reached). Moving guard ahead of setup means denied
requests allocate *nothing*.

**Architecture:** cross-layer, dependency direction preserved. The guard
invocation is extracted into a `runGuard(def, ctx)` **core** export (framework
domain) so both the new-instance adapter path and the existing
`instance.authorize` path share one implementation; the `server-bun`
**adapter** calls it before allocating; the `vite-plugin`/CLI scaffold
templates (a **vertical** cutting through codegen) reflect the new "guard
before setup" lifecycle order. `core` gains the export but never imports the
adapter — one-way direction holds.

**Files:** `handler.ts` (`mountInstance`), `packages/core/src/instance.ts`
(expose guard-evaluable pre-instance), CLI/vite-plugin scaffold templates.

**Sketch —** lift guard out of the instance for the new-instance path (the
warm-reuse/reconcile path keeps `instance.authorize` since the instance already
exists):

```ts
// mountInstance, new-instance branch:
if (route.def.guard) {
  await runGuard(route.def, { params: match.params, session });
}
const instance = await LiveInstance.create({ /* … */ });
try {
  await instance.loadForRender(search);
} catch (e) {
  await instance.dispose(false); throw e;
}
```

**Implementer notes / risk:** confirm `def.guard`'s ctx does **not** read
setup-produced `ctx.state` — it should gate on `session`/`params` only. If any
userland guard reads state, this reorder changes semantics; document "guard
runs before setup; gate on session/params, not state." Extract the guard
invocation into a standalone `runGuard(def, ctx)` core export (or a shared
helper) to avoid duplicating the redirect handling.

**Scaffolder:** update generated route templates + their comments to reflect
"setup runs only after guard passes," and update any generated lifecycle-order
test. Templates live under the CLI generators / `vite-plugin`.

**TDD (failing-first confirms the leak):** guarded route denies →
`instanceCount === 0` and no live bus subscription left (bus-subscriber spy);
load throws → instance disposed + storage cleaned.
