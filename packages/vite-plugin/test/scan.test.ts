/**
 * TDD for the syntactic live() discovery scan (ADR 0002 item 4): exported
 * live() objects anywhere in the tree are registered by their pattern; the
 * TypeScript AST (not regex, not execution) resolves indirection and ignores
 * comments/strings; unexported / non-literal / duplicate patterns are build
 * errors naming the file(s); node_modules and test globs are excluded.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isLiveScanCandidate, LiveScanError, scanLiveModules } from "../src/index.ts";

const dirs: string[] = [];
function makeProject(): string {
  const root = mkdtempSync(join(tmpdir(), "rpxd-scan-"));
  dirs.push(root);
  mkdirSync(join(root, "routes"), { recursive: true });
  return root;
}
function write(root: string, rel: string, contents: string): void {
  const abs = join(root, rel);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, contents);
}
const scan = (root: string) =>
  scanLiveModules(root, { routesDir: join(root, "routes"), outDir: join(root, ".rpxd") });

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("scanLiveModules — discovery", () => {
  it("registers an exported live() object in an arbitrary directory by its pattern", () => {
    const root = makeProject();
    write(
      root,
      "src/slots/chat.tsx",
      `import { live } from "@rpxd/core";
export default live("/chat").setup(() => ({ n: 0 })).render(() => null);`,
    );
    expect(scan(root)).toEqual([{ file: "src/slots/chat.tsx", path: "/chat" }]);
  });

  it("resolves `const x = live(...); export default x` indirection", () => {
    const root = makeProject();
    write(
      root,
      "widgets/counter.tsx",
      `import { live } from "@rpxd/core";
const Counter = live("/counter").setup(() => ({})).render(() => null);
export default Counter;`,
    );
    expect(scan(root).map((e) => e.path)).toEqual(["/counter"]);
  });

  it("supports import aliasing: `import { live as l }`", () => {
    const root = makeProject();
    write(
      root,
      "src/aliased.tsx",
      `import { live as l } from "@rpxd/core";
export default l("/aliased").render(() => null);`,
    );
    expect(scan(root).map((e) => e.path)).toEqual(["/aliased"]);
  });

  it("ignores `live(` inside comments and string literals (AST, not regex)", () => {
    const root = makeProject();
    write(
      root,
      "src/decoys.tsx",
      `import { live } from "@rpxd/core";
// export default live("/comment-decoy")
const s = 'live("/string-decoy")';
export default live("/real").render(() => null);`,
    );
    expect(scan(root).map((e) => e.path)).toEqual(["/real"]);
  });

  it("ignores a file that imports live but never calls it", () => {
    const root = makeProject();
    write(root, "src/typeonly.ts", `import { live } from "@rpxd/core";\nexport const x = 1;`);
    expect(scan(root)).toEqual([]);
  });

  it("ignores a same-named local live() with no @rpxd/core import", () => {
    const root = makeProject();
    write(
      root,
      "src/local.tsx",
      `function live(p: string) { return p; }\nexport default live("/not-ours");`,
    );
    expect(scan(root)).toEqual([]);
  });

  it("returns entries deterministically ordered by pattern", () => {
    const root = makeProject();
    write(
      root,
      "a/z.tsx",
      `import { live } from "@rpxd/core";\nexport default live("/z").render(()=>null);`,
    );
    write(
      root,
      "a/a.tsx",
      `import { live } from "@rpxd/core";\nexport default live("/a").render(()=>null);`,
    );
    expect(scan(root).map((e) => e.path)).toEqual(["/a", "/z"]);
  });
});

describe("scanLiveModules — exclusions", () => {
  it("excludes the routes dir (registered via routes.gen.ts)", () => {
    const root = makeProject();
    write(
      root,
      "routes/index.tsx",
      `import { live } from "@rpxd/core";\nexport default live("/").render(()=>null);`,
    );
    expect(scan(root)).toEqual([]);
  });

  it("excludes node_modules and test globs", () => {
    const root = makeProject();
    const mod = `import { live } from "@rpxd/core";\nexport default live("/ignored").render(()=>null);`;
    write(root, "node_modules/pkg/index.tsx", mod);
    write(root, "src/test/fixture.tsx", mod.replace("/ignored", "/in-test-dir"));
    write(root, "src/test-bun/fixture.tsx", mod.replace("/ignored", "/in-test-bun"));
    write(root, "src/widget.test.tsx", mod.replace("/ignored", "/dot-test"));
    write(root, "src/widget.test-d.ts", mod.replace("/ignored", "/dot-test-d"));
    write(root, "dist/bundle.js", mod.replace("/ignored", "/in-dist"));
    expect(scan(root)).toEqual([]);
  });
});

describe("scanLiveModules — build errors (name the file)", () => {
  it("errors when a live() object is declared but not default-exported", () => {
    const root = makeProject();
    write(
      root,
      "src/orphan.tsx",
      `import { live } from "@rpxd/core";\nconst x = live("/orphan").render(()=>null);\nexport const y = 1;`,
    );
    expect(() => scan(root)).toThrow(LiveScanError);
    expect(() => scan(root)).toThrow(/src\/orphan\.tsx.*not exported/s);
  });

  it("errors on a non-literal (template with substitution) pattern, naming the file", () => {
    const root = makeProject();
    // `dollar` keeps the `${` out of any single source literal (biome flags it)
    // while the written fixture still contains a real `${base}` substitution.
    const dollar = "$";
    const fixture = `import { live } from "@rpxd/core";
const base = "/x";
export default live(\`/card/${dollar}{base}\`).render(()=>null);`;
    write(root, "src/dynamic.tsx", fixture);
    expect(() => scan(root)).toThrow(/src\/dynamic\.tsx.*static string literal/s);
  });

  it("errors on more than one live() call in a module, naming the file", () => {
    const root = makeProject();
    write(
      root,
      "src/two.tsx",
      `import { live } from "@rpxd/core";
const a = live("/a").render(()=>null);
const b = live("/b").render(()=>null);
export default a;`,
    );
    expect(() => scan(root)).toThrow(/src\/two\.tsx.*more than one live/s);
  });

  it("errors on a duplicate pattern across two scanned modules, naming both files", () => {
    const root = makeProject();
    write(
      root,
      "src/one.tsx",
      `import { live } from "@rpxd/core";\nexport default live("/dup").render(()=>null);`,
    );
    write(
      root,
      "src/two.tsx",
      `import { live } from "@rpxd/core";\nexport default live("/dup").render(()=>null);`,
    );
    let caught: unknown;
    try {
      scan(root);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(LiveScanError);
    const msg = (caught as Error).message;
    expect(msg).toContain("src/one.tsx");
    expect(msg).toContain("src/two.tsx");
    expect(msg).toContain("/dup");
  });
});

describe("isLiveScanCandidate (watcher predicate)", () => {
  const root = "/app";
  const opts = { routesDir: "/app/routes", outDir: "/app/.rpxd" };
  it("accepts source files outside routes/out/excludes", () => {
    expect(isLiveScanCandidate("/app/src/chat.tsx", root, opts)).toBe(true);
    expect(isLiveScanCandidate("/app/widgets/x.ts", root, opts)).toBe(true);
  });
  it("rejects routes-dir files, generated output, node_modules, tests, non-source", () => {
    expect(isLiveScanCandidate("/app/routes/index.tsx", root, opts)).toBe(false);
    expect(isLiveScanCandidate("/app/.rpxd/live.gen.ts", root, opts)).toBe(false);
    expect(isLiveScanCandidate("/app/node_modules/p/i.tsx", root, opts)).toBe(false);
    expect(isLiveScanCandidate("/app/src/x.test.tsx", root, opts)).toBe(false);
    expect(isLiveScanCandidate("/app/src/test/x.tsx", root, opts)).toBe(false);
    expect(isLiveScanCandidate("/app/styles.css", root, opts)).toBe(false);
    expect(isLiveScanCandidate("/other/x.tsx", root, opts)).toBe(false);
  });
  it("re-includes a default-excluded file when a user `include` re-reaches it (finding 5)", () => {
    const withInclude = { ...opts, include: ["**/test/**"] };
    expect(isLiveScanCandidate("/app/src/test/x.tsx", root, withInclude)).toBe(true);
    // The routes/out dirs are excluded structurally — an include never reaches them.
    expect(isLiveScanCandidate("/app/routes/test/x.tsx", root, withInclude)).toBe(false);
  });
  it("honors a user `exclude` glob (finding 5)", () => {
    const withExclude = { ...opts, exclude: ["**/vendor/**"] };
    expect(isLiveScanCandidate("/app/src/vendor/x.tsx", root, withExclude)).toBe(false);
    expect(isLiveScanCandidate("/app/src/app/x.tsx", root, withExclude)).toBe(true);
  });
});
