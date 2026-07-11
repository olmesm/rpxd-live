#!/usr/bin/env bun
/**
 * Release-manifest invariants (pre-release checklist item 7/11): every
 * publishable package must declare an MIT license, the repo must ship a root
 * LICENSE file, the React-19-only packages must declare accurate peer ranges,
 * and the root manifest must pin a packageManager so installs are
 * reproducible. Run standalone (`bun scripts/check-release-manifests.ts`) or
 * wired into CI, alongside `check-tsdoc.ts`.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const failures: string[] = [];

const rootPkgPath = "package.json";
const rootPkg = JSON.parse(readFileSync(rootPkgPath, "utf-8")) as Record<string, unknown>;

if (!existsSync("LICENSE")) {
  failures.push("LICENSE: root LICENSE file is missing");
}

if (typeof rootPkg.packageManager !== "string" || rootPkg.packageManager.trim() === "") {
  failures.push(`${rootPkgPath}: missing "packageManager" field`);
}

if (rootPkg.license !== "MIT") {
  failures.push(`${rootPkgPath}: "license" must be "MIT" (got ${JSON.stringify(rootPkg.license)})`);
}

const packageDirs = readdirSync("packages").filter((name) => {
  try {
    return statSync(join("packages", name)).isDirectory();
  } catch {
    return false;
  }
});

for (const dir of packageDirs) {
  const pkgPath = join("packages", dir, "package.json");
  if (!existsSync(pkgPath)) continue;
  const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as Record<string, unknown>;

  if (pkg.license !== "MIT") {
    failures.push(`${pkgPath}: "license" must be "MIT" (got ${JSON.stringify(pkg.license)})`);
  }

  if (dir === "rsc" || dir === "cli") {
    const peers = (pkg.peerDependencies ?? {}) as Record<string, unknown>;
    if (peers.react !== ">=19") {
      failures.push(
        `${pkgPath}: peerDependencies.react must be ">=19" (got ${JSON.stringify(peers.react)})`,
      );
    }
    if (peers["react-dom"] !== ">=19") {
      failures.push(
        `${pkgPath}: peerDependencies["react-dom"] must be ">=19" (got ${JSON.stringify(
          peers["react-dom"],
        )})`,
      );
    }
  }
}

if (failures.length > 0) {
  console.error(`Release manifest check failed with ${failures.length} violation(s):\n`);
  for (const f of failures) console.error(`  ${f}`);
  process.exit(1);
}
console.log("Release manifest check passed: license, LICENSE, peers, and packageManager all set.");
