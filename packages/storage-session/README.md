# @rpxd/storage-session

In-memory snapshots that expire a fixed time after their last write —
session continuity without unbounded memory growth.

```sh
bun add @rpxd/storage-session
```

Not yet on npm — work from a clone of the repo for now.

```ts
import { session } from "@rpxd/storage-session";

export default defineConfig({
  storage: session({ ttlMs: 30 * 60_000 }), // default 30 minutes
});
```

An expired snapshot only costs the next visitor a reload — nothing is lost
that `setup` + `load` can't rebuild. Snapshots are session continuity, not a
cache — see
[Persistence](https://olmesm.github.io/rpxd-live/concepts/persistence/).

The pubsub bus stays in-process, so this adapter is single-node. Use
[`@rpxd/storage-redis`](../storage-redis) when broadcasts must cross nodes.

Docs: https://olmesm.github.io/rpxd-live/
