#!/usr/bin/env bun
// Release-only rewrite of packages/rsc/package.json#exports, src -> dist.
//
// Every other publishable package sets `zshy.noEdit` unset (the default),
// so `bun run build` (zshy) rewrites its committed `exports` (->src, the dev
// loop) to point at `dist` as a build side effect. rsc opts out via
// `zshy.noEdit: true` — its committed `exports` uses a `react-server`
// condition (RSC's server/client split) that zshy doesn't understand and
// would clobber, so rsc's `exports` is rewritten by hand, here, release-time
// only. Committed `exports` must always read ->src; this script is only ever
// run in a release checkout (see .github/workflows/release.yml), never
// checked in with its output applied.
//
// zshy names dist output by source basename: server.ts -> dist/server.js
// (+ .d.ts), server-stub.ts -> dist/server-stub.js, client.ts ->
// dist/client.js. Run `cd packages/rsc && bun run build` first so dist/
// exists, then `bun scripts/release-exports-rsc.ts` from the repo root.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const pkgPath = join("packages", "rsc", "package.json");
const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as Record<string, unknown>;

pkg.exports = {
  ".": {
    "react-server": { types: "./dist/server.d.ts", import: "./dist/server.js" },
    default: { types: "./dist/server-stub.d.ts", import: "./dist/server-stub.js" },
  },
  "./client": { types: "./dist/client.d.ts", import: "./dist/client.js" },
};

writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
console.log(`${pkgPath}: exports rewritten -> dist (release-only).`);
