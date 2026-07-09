/**
 * SQLite storage adapter (§9) for the Node runtime, via `better-sqlite3` —
 * the `node:http`/`@rpxd/adapter-node` counterpart to {@link sqlite} (which
 * uses `bun:sqlite`). Same schema, same {@link StorageAdapter} interface, same
 * in-process `LocalBus`; only the driver differs. Kept in its own module so
 * `bun:sqlite` is never imported under Node.
 *
 * @packageDocumentation
 */
import { LocalBus, type Snapshot, type StorageAdapter } from "@rpxd/core";
import Database from "better-sqlite3";

/**
 * Create a SQLite-backed storage adapter for Node (`better-sqlite3`).
 *
 * @param path - Database file path, or `":memory:"` for tests.
 *
 * @example
 * ```ts
 * import { sqliteNode } from "@rpxd/storage-sqlite/node";
 * export default defineConfig({ storage: sqliteNode("./data.db") });
 * ```
 */
export function sqliteNode(path: string): StorageAdapter {
  const db = new Database(path);
  db.exec(`CREATE TABLE IF NOT EXISTS rpxd_snapshots (
    key TEXT PRIMARY KEY,
    state TEXT NOT NULL,
    session TEXT NOT NULL,
    seq INTEGER NOT NULL,
    version TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  )`);
  const upsert = db.prepare(
    `INSERT INTO rpxd_snapshots (key, state, session, seq, version, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET
       state = excluded.state, session = excluded.session,
       seq = excluded.seq, version = excluded.version, updated_at = excluded.updated_at`,
  );
  const select = db.prepare(
    "SELECT state, session, seq, version FROM rpxd_snapshots WHERE key = ?",
  );
  const remove = db.prepare("DELETE FROM rpxd_snapshots WHERE key = ?");

  return {
    get(key): Snapshot | undefined {
      const row = select.get(key) as
        | { state: string; session: string; seq: number; version: string }
        | undefined;
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
