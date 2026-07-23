# ADR 0003 — Instance per stream: a live object belongs to one tab

- Status: accepted — implemented
- Date: 2026-07-23

## Context

Instance identity was **(session, pattern-qualified pathname)**: every tab of
one browser session that visited the same identity shared one server instance
(ADR 0002 Decisions 2/4 leaned on this — "two-tabs semantics"). Sharing was
supposed to make multi-tab realtime free, but the evidence ran the other way:

- **Everything realtime already rides the bus.** Cross-user chat cannot share
  instances (they're session-keyed), so it broadcasts (`ctx.broadcast` +
  `.on`, §8) — and that machinery serves same-user tabs identically. Instance
  sharing powered no feature the bus didn't already power.
- **Sharing bred an aliasing bug class**: client-local things colliding on the
  shared instance. Three shipped bugs in a row were this class — the rpcId
  dedupe collision (two tabs' batches swallowed as "resends"), the two-tab
  filter/URL divergence (one tab's `nav.patch` rewrote the other tab's view
  but not its URL), and the refresh-revert (a stale tab's reload reconciled
  the shared instance back to old props under the other tab).
- Phoenix LiveView — a decade of production evidence for this shape — scopes
  live state to the socket. Params/assigns per tab; shared data via PubSub.

## Decision

**A live instance belongs to ONE client stream (one tab).**

- The registry key is `${streamScope}\n${pattern-qualified pathname}` where
  `streamScope` is the owning stream id, or a unique `g:` placeholder for a
  GET/cold mount no stream has claimed yet.
- **Warm reuse is a same-stream property**: a tab re-mounting its own identity
  (slot remount, nav-away-and-back, the Decision-4 load dedup) reuses its own
  instance. Another tab's mount of the same identity builds a fresh instance.
- **Page GETs always build fresh** (a reload is a new instance, Phoenix-style).
- **Ownership is claimed by attach token**: the SSR bootstrap token proves a
  stream is the tab the GET served. The claim happens at stream connect
  (`?attach`) or on a control mount carrying the new `attach` field —
  order-free, so Decision-2 page↔slot sharing survives any connect/mount
  race. Token EQUALITY (constant-time) proves ownership; expiry only bounds
  the un-adopted instance's lifetime.
- **`subscribeSession` subscribes a stream only to instances it owns** (plus
  the token claim). The pre-0003 loop fanned every session instance to every
  stream — each tab received all tabs' envelopes.
- A cold control mount (no stream — `LiveConnection.mount`) answers with its
  `attach` token so the later-connecting stream can claim it.
- The WS upgrade URL carries `?stream=<id>` (the client's connection stream
  id, same id its control POSTs name), so POST-mount + frame-join land on one
  instance.
- **The storage row stays identity-keyed** (`${sid}:${pattern\npathname}`):
  the snapshot carries the session slice (§9 continuity), which is per-user
  shared state — every tab's instance of one identity shares the row, last
  writer wins. Because the cold path now restores on every reload, it applies
  the same principal-change rule the warm branch always had: a snapshot whose
  session no longer matches the freshly authenticated one is deleted, never
  revived (the sign-out → reload flow).

## Consequences

- The aliasing class is **unexpressible**: per-tab URL state, per-tab
  optimistic queues, per-tab loads. `s.filter = props.filter` in a loader is
  now the *correct* pattern, not a trap.
- One sharing story: the bus, for other tabs and other users alike
  (exclude-self default; `{ self: true }` for own-echo).
- N tabs cost N instances and N loader runs — the Phoenix trade. Bounded by
  the existing per-session caps; the domain layer can cache.
- Cross-tab freshness for non-broadcast routes is gone by design (each tab is
  its own view). Routes that want it broadcast domain events (see
  kitchen-sink chat).
- A deliberate fan-out route (one hot instance, many viewers) is no longer
  expressible via implicit sharing; if that scaling shape is needed it should
  return as an explicit opt-in (`shared: true`) — future work, not lost
  silently.

## Supersedes

Amends ADR 0002: Decision 2 (addressability) and Decision 4 (warm-mount
dedup) survive **scoped to one stream**; their cross-tab readings are
superseded. Spec §7/§9/§12 language updated accordingly.
