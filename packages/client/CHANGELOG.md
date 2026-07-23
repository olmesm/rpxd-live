# @rpxd/client

## 0.2.0

### Minor Changes

- c520fbd: Pre-release hardening: secure-by-default guards, CSRF, crash-safe dispatch, build pipeline.
- 3dc52f9: `LiveApp` stamps `<html data-rpxd-synced>` whenever every store multiplexed on
  the app connection is settled (each `status === "live"` with an empty optimistic
  queue), and removes it while any rpc is in flight — so it flickers OFF during an
  action and back ON at ack. `LiveConnection` exposes the aggregate as
  `conn.synced` (lazy) plus `conn.subscribeSync(cb)` (fires on any store snapshot
  or membership change). Tests (and apps) can now wait for the marker AFTER an
  action as a deterministic "the write landed" signal instead of guessing with a
  timeout — the companion to `data-rpxd-hydrated`.

### Patch Changes

- Updated dependencies [c520fbd]
  - @rpxd/core@0.2.0
