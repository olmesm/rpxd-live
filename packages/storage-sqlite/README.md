# @rpxd/storage-sqlite

Durable snapshots in SQLite via `bun:sqlite` — sessions survive server
restarts on a single node.

```ts
import { sqlite } from "@rpxd/storage-sqlite";

export default defineConfig({ storage: sqlite("data/app.db") });
```

Write-through: every patch flush persists the `{ state, session, seq,
version }` snapshot. On wake, the session slice is restored and `setup` +
`load` rerun for page state (§9) — snapshots are continuity, not cache, so the
database never serves stale multiplayer state.

The pubsub bus stays in-process (`LocalBus`); use
[`@rpxd/storage-redis`](../storage-redis) when fan-out must cross nodes.
(The future Node adapter swaps `bun:sqlite` for `better-sqlite3` — same
schema, same interface.)
