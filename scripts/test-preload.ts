/**
 * `bun test` preload (wired via `bunfig.toml`'s `[test] preload`): the
 * secure-by-default secret guard (S1, `isDev()` in `@rpxd/core`) would throw
 * for the many existing no-secret handler constructions across the
 * Bun-runtime suite unless this runs as development. `bun test` itself sets
 * `NODE_ENV="test"` before any preload executes, so a bare `??=` would no-op
 * against bun's own synthetic default — this treats "test" the same as unset,
 * while still respecting any other explicit override (e.g. a specific
 * test-bun file or CI invocation that sets `NODE_ENV=production` /
 * `staging` / `development` itself before this runs).
 */
if (process.env.NODE_ENV === undefined || process.env.NODE_ENV === "test") {
  process.env.NODE_ENV = "development";
}
