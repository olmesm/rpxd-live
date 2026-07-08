# @rpxd/storage-memory

The default storage adapter: in-memory snapshots and an in-process pubsub
bus. State lives for the lifetime of the server process — right for dev and
single-node deployments without durability needs.

```ts
import { memory } from "@rpxd/storage-memory";

export default defineConfig({ storage: memory() }); // also the default
```

Snapshots in rpxd are **session continuity, not cache** (§9): a cold wake
always re-runs `mount`, so losing memory on restart only costs a re-mount.

The implementation lives in `@rpxd/core` (the runtime defaults to it);
this package is the canonical import for userland configs. For durability
or multi-node fan-out see [`@rpxd/storage-sqlite`](../storage-sqlite),
[`@rpxd/storage-session`](../storage-session), and
[`@rpxd/storage-redis`](../storage-redis).
