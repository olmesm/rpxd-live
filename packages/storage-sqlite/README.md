# @rpxd/storage-sqlite

Durable snapshots in SQLite via `bun:sqlite` — sessions survive server
restarts on a single node.

```sh
bun add @rpxd/storage-sqlite
```

Not yet on npm — work from a clone of the repo for now.

```ts
import { sqlite } from "@rpxd/storage-sqlite";

export default defineConfig({ storage: sqlite("data/app.db") });
```

Every patch flush writes the `{ state, session, seq, version }` snapshot
through to the database. When an instance wakes, the session slice is
restored and `setup` + `load` rerun for page state, so the database never
serves stale multiplayer state. Snapshots are session continuity, not a
cache — see
[Persistence](https://olmesm.github.io/rpxd-live/concepts/persistence/).

The pubsub bus stays in-process, so this adapter is single-node. Use
[`@rpxd/storage-redis`](../storage-redis) when fan-out must cross nodes.

## On Node

The default entry is written against `bun:sqlite`. For Node runtimes, the
`@rpxd/storage-sqlite/node` entry provides the same schema and interface on
top of `better-sqlite3` — an optional peer dependency, so install it yourself
when using that entry:

```sh
npm install better-sqlite3
```

```ts
import { sqliteNode } from "@rpxd/storage-sqlite/node";

export default defineConfig({ storage: sqliteNode("data/app.db") });
```

Docs: https://olmesm.github.io/rpxd-live/
