# @rpxd/storage-session

In-memory snapshots that expire a fixed time after their last write —
session continuity without unbounded memory growth.

```ts
import { session } from "@rpxd/storage-session";

export default defineConfig({
  storage: session({ ttlMs: 30 * 60_000 }), // default 30 minutes
});
```

Because snapshots are continuity, not cache (§9), an expired snapshot only
costs the next visitor a re-mount — nothing is lost that `mount` can't
rebuild. The pubsub bus stays in-process (`LocalBus`), so this adapter is
single-node; use [`@rpxd/storage-redis`](../storage-redis) when broadcasts
must cross nodes.
