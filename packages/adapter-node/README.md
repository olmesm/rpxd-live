# @rpxd/adapter-node

A v2 stub — rpxd v1 runs on Bun. This package exists so the `ServerAdapter`
seam is proven by structure (§17): the runtime handler is fully web-standard
(`Request`/`Response`/`ReadableStream`) with no Bun types past the adapter
boundary, so the Node adapter is ~100 lines of `node:http` bridging when it
lands, plus `better-sqlite3` swapped into `@rpxd/storage-sqlite`.

```ts
import { nodeAdapter } from "@rpxd/adapter-node";

nodeAdapter(); // throws: run rpxd on Bun (bunAdapter) for now
```

Until then, use [`@rpxd/server-bun`](../server-bun).
