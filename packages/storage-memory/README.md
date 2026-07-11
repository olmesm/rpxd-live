# @rpxd/storage-memory

The default storage adapter: in-memory snapshots and an in-process pubsub
bus. State lives for the lifetime of the server process — right for dev and
single-node deployments without durability needs.

```sh
bun add @rpxd/storage-memory
```

Not yet on npm — work from a clone of the repo for now.

```ts
import { memory } from "@rpxd/storage-memory";

export default defineConfig({ storage: memory() }); // also the default
```

Losing memory on a restart only costs the next visitor a reload: rpxd always
re-runs `setup` + `load` when an instance comes back. Snapshots are session
continuity, not a cache — see
[Persistence](https://olmesm.github.io/rpxd-live/concepts/persistence/).

The implementation ships inside `@rpxd/core` (it is the runtime's default);
this package is the canonical import for app configs. For durability or
multi-node fan-out see [`@rpxd/storage-sqlite`](../storage-sqlite),
[`@rpxd/storage-session`](../storage-session), and
[`@rpxd/storage-redis`](../storage-redis).

Docs: https://olmesm.github.io/rpxd-live/
