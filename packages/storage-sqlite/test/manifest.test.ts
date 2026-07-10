/**
 * Packaging contract: `better-sqlite3` is a native module used only by the
 * `./node` subpath (src/node.ts), so it must be an optional peer — Bun-only
 * consumers of the `bun:sqlite` export must not have to compile it.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as Record<
  string,
  Record<string, { optional?: boolean } | string> | undefined
>;

describe("@rpxd/storage-sqlite manifest", () => {
  it("declares better-sqlite3 as an optional peer, not a hard dependency", () => {
    expect(pkg.dependencies?.["better-sqlite3"]).toBeUndefined();
    expect(pkg.peerDependencies?.["better-sqlite3"]).toBeDefined();
    expect(pkg.peerDependenciesMeta?.["better-sqlite3"]).toEqual({ optional: true });
    // Kept in devDependencies so the workspace's own Node tests still install it.
    expect(pkg.devDependencies?.["better-sqlite3"]).toBeDefined();
  });
});
