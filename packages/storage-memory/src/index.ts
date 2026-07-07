/**
 * In-memory storage adapter (§9) — the default. Re-exported from
 * `@rpxd/core` so the core runtime can default to it without a cycle;
 * this package is the canonical import for userland configs.
 *
 * @example
 * ```ts
 * import { memory } from "@rpxd/storage-memory";
 * export default defineConfig({ storage: memory() });
 * ```
 *
 * @packageDocumentation
 */
export { LocalBus, memory } from "@rpxd/core";
