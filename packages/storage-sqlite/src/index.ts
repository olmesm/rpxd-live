/**
 * SQLite storage adapter (§9) via `bun:sqlite` — durable snapshots for
 * single-node deployments. The pubsub bus stays in-process (`LocalBus`);
 * use `@rpxd/storage-redis` when fan-out must cross nodes (§8).
 *
 * (The future Node adapter swaps `bun:sqlite` for `better-sqlite3` — same
 * schema, same interface.)
 *
 * @packageDocumentation
 */
import { Database } from "bun:sqlite";
import { LocalBus, type Snapshot, type StorageAdapter } from "@rpxd/core";

/**
 * Create a SQLite-backed storage adapter.
 *
 * @param path - Database file path, or `":memory:"` for tests.
 *
 * @example
 * ```ts
 * export default defineConfig({ storage: sqlite("./data.db") });
 * ```
 */
export function sqlite(path: string): StorageAdapter {
  const db = new Database(path);
  db.run(`CREATE TABLE IF NOT EXISTS rpxd_snapshots (
    key TEXT PRIMARY KEY,
    state TEXT NOT NULL,
    session TEXT NOT NULL,
    seq INTEGER NOT NULL,
    version TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  )`);
  const upsert = db.prepare(
    `INSERT INTO rpxd_snapshots (key, state, session, seq, version, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6)
     ON CONFLICT(key) DO UPDATE SET
       state = excluded.state, session = excluded.session,
       seq = excluded.seq, version = excluded.version, updated_at = excluded.updated_at`,
  );
  const select = db.prepare(
    "SELECT state, session, seq, version FROM rpxd_snapshots WHERE key = ?1",
  );
  const remove = db.prepare("DELETE FROM rpxd_snapshots WHERE key = ?1");

  return {
    get(key): Snapshot | undefined {
      const row = select.get(key) as {
        state: string;
        session: string;
        seq: number;
        version: string;
      } | null;
      if (!row) return undefined;
      return {
        state: JSON.parse(row.state),
        session: JSON.parse(row.session),
        seq: row.seq,
        version: row.version,
      };
    },
    set(key, snap) {
      upsert.run(
        key,
        JSON.stringify(snap.state),
        JSON.stringify(snap.session ?? {}),
        snap.seq,
        snap.version,
        Date.now(),
      );
    },
    delete(key) {
      remove.run(key);
    },
    bus: new LocalBus(),
  };
}
