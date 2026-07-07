/**
 * Session-scoped storage adapter (§9): in-memory snapshots that expire a
 * fixed time after their last write. Gives reconnecting clients session
 * continuity without unbounded memory growth — snapshots are continuity,
 * not cache (§9), so letting them lapse only costs a re-mount.
 *
 * @packageDocumentation
 */
import { LocalBus, type Snapshot, type StorageAdapter } from "@rpxd/core";

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

  const sweep = () => {
    const now = Date.now();
    for (const [key, entry] of snapshots) {
      if (entry.expires <= now) snapshots.delete(key);
    }
  };

  return {
    get(key) {
      sweep();
      return snapshots.get(key)?.snap;
    },
    set(key, snap) {
      snapshots.set(key, { snap, expires: Date.now() + ttlMs });
    },
    delete(key) {
      snapshots.delete(key);
    },
    bus: new LocalBus(),
  };
}
