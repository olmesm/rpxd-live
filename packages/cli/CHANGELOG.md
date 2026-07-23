# @rpxd/cli

## 0.2.0

### Minor Changes

- d938bff: Per-connection egress byte budget (`maxBufferedBytes`, default 8 MiB, `null`
  disables): a connection buffering more unsent bytes than the budget is killed
  with a `security`/`stream-overflow` diagnostic, and the client's reconnect
  recovers via the resync snapshot. Enforced continuously on WS (both runtimes)
  and Node-adapter SSE; on Bun SSE it catches burst overflows only (Bun buffers
  streamed responses internally). The Node adapter also now destroys a response
  whose body stream errors while parked on backpressure, so killed connections
  are reaped instead of leaked. Configurable via the config `instances` block.
- b9d2e04: The client entry stamps `<html data-rpxd-hydrated>` after `hydrateRoot`
  commits. Interacting before hydration loses clicks or falls through to
  native form submits; tests (and apps) can now gate interaction on the
  marker instead of guessing with timeouts.
- c520fbd: Pre-release hardening: secure-by-default guards, CSRF, crash-safe dispatch, build pipeline.

### Patch Changes

- Updated dependencies [d938bff]
- Updated dependencies [c520fbd]
  - @rpxd/server-bun@0.2.0
  - @rpxd/adapter-node@0.2.0
  - @rpxd/core@0.2.0
  - @rpxd/rsc@0.2.0
  - @rpxd/vite-plugin@0.2.0
