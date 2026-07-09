# @rpxd/adapter-node

A placeholder that holds the `ServerAdapter` seam open — rpxd runs on Bun
(`@rpxd/server-bun`). The runtime handler is fully web-standard
(`Request`/`Response`/`ReadableStream`) with no Bun types past the adapter
boundary (§17), so a Node adapter is a thin `node:http` bridge plus
`better-sqlite3` in place of `bun:sqlite`. This package has no implementation.

```ts
import { nodeAdapter } from "@rpxd/adapter-node";

nodeAdapter(); // throws — run rpxd on Bun (bunAdapter)
```

Use [`@rpxd/server-bun`](../server-bun).
