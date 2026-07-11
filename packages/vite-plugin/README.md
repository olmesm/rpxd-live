# @rpxd/vite-plugin

Route codegen for rpxd's file-based routing: it scans `routes/`, generates
the typed route table, and keeps each route file's path literal in sync with
its filename.

```sh
bun add @rpxd/vite-plugin
```

Not yet on npm — work from a clone of the repo for now.

Registered automatically by `rpxd dev`/`rpxd build` — you only need this
package directly for custom Vite setups or to run codegen standalone.

## What it does

- **`routes/` → `.rpxd/routes.gen.ts`** — flat filenames map to URL paths
  (`org.$orgId.board.tsx` → `/org/$orgId/board`; `__root`/`__404`/`__error`
  are the shell). The generated module exports the route tree and lazy
  module loaders. It also augments the `Register` interface (TypeScript
  declaration merging), which is what makes `Link`, `useNav`, and
  `nav.navigate` fully typed across the app with zero imports.
- **`.ts` route files** export a `route()` (webhooks, auth) instead of a
  page. Their server-only handlers are generated into a separate module so
  they never reach the client bundle.
- **Path-literal maintenance** — the filename is the source of truth.
  Rename a route file and the plugin rewrites the `live("...")` /
  `route("...")` literal inside it to match. Heads-up: this edits your
  source file, and hand-edits to the literal are corrected back too.

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

Docs: https://olmesm.github.io/rpxd-live/guides/routing/
