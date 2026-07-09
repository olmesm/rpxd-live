/**
 * Session-scoped storage adapter (§9): in-memory snapshots that expire a
 * fixed time after their last write. Gives reconnecting clients session
 * continuity without unbounded memory growth — snapshots are continuity,
 * not cache (§9), so letting them lapse only costs a re-mount.
 *
 * @packageDocumentation
 */
import { LocalBus, type Snapshot, type StorageAdapter } from "@rpxd/core";

/** Options for {@link session}. */
export interface SessionStorageOptions {
  /** Drop snapshots this long after their last write. Default 30 minutes. */
  ttlMs?: number;
}

/**
 * Create a session-scoped storage adapter.
 *
 * @example
 * ```ts
 * export default defineConfig({ storage: session({ ttlMs: 10 * 60_000 }) });
 * ```
 */
export function session(opts: SessionStorageOptions = {}): StorageAdapter {
  const ttlMs = opts.ttlMs ?? 30 * 60_000;
  const snapshots = new Map<string, { snap: Snapshot; expires: number }>();
  let lastSweep = Date.now();

  // Bulk-evict expired entries. Kept off the read path (which now checks only
  // the requested key) and run at most once per TTL from `set`, so a hot `get`
  // is O(1) instead of O(entries).
  const sweep = (now: number) => {
    lastSweep = now;
    for (const [key, entry] of snapshots) {
      if (entry.expires <= now) snapshots.delete(key);
    }
  };

  // Match the durable adapters' round-trip semantics: stored state is isolated
  // from the live/returned object, so callers can't mutate storage by reference.
  const clone = (snap: Snapshot): Snapshot => structuredClone(snap);

  return {
    get(key) {
      const entry = snapshots.get(key);
      if (!entry) return undefined;
      if (entry.expires <= Date.now()) {
        snapshots.delete(key); // lazy per-key expiry
        return undefined;
      }
      return clone(entry.snap);
    },
    set(key, snap) {
      const now = Date.now();
      snapshots.set(key, { snap: clone(snap), expires: now + ttlMs });
      if (now - lastSweep >= ttlMs) sweep(now);
    },
    delete(key) {
      snapshots.delete(key);
    },
    bus: new LocalBus(),
  };
}
