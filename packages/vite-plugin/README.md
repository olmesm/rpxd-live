# @rpxd/vite-plugin

Route codegen for rpxd's file-based routing: scans `routes/`, generates the
typed route table, and keeps in-file path literals honest.

Registered automatically by `rpxd dev`/`rpxd build` — you only need this
package directly for custom Vite setups or to run codegen standalone.

## What it does

- **`routes/` → `.rpxd/routes.gen.ts`** — flat filenames map to URL paths
  (`org.$orgId.board.tsx` → `/org/$orgId/board`; `__root`/`__404`/`__error`
  are the shell). The generated module exports the route tree, lazy module
  loaders, and a `Register` interface merge that types `Link`,
  `useNav`, and `nav.navigate` across the app with zero imports.
- **Path-literal maintenance** — the filename is truth: rename a route file
  and the `live("...")` literal inside it is rewritten; hand-edit the
  literal and it's corrected back.

## Usage

```ts
import { rpxd } from "@rpxd/vite-plugin";

export default defineConfig({ plugins: [rpxd()] });
```

Or one-shot, outside Vite:

```ts
import { runCodegen } from "@rpxd/vite-plugin";
runCodegen(projectRoot);
```

`.rpxd/routes.gen.ts` is generated *and committed* — the types work in
editors without a dev server running.
