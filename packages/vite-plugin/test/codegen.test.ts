import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ensurePathLiteral,
  generateHandlersModule,
  generateRoutesModule,
  scanRoutes,
} from "../src/codegen.ts";
import { runCodegen } from "../src/index.ts";
import { fileToRoute, pathToPattern, type RouteEntry } from "../src/routes.ts";

describe("fileToRoute (§7)", () => {
  it("maps flat filenames to URL paths", () => {
    expect(fileToRoute("index.tsx")).toEqual({ file: "index.tsx", path: "/", kind: "page" });
    expect(fileToRoute("org.$orgId.board.tsx")).toEqual({
      file: "org.$orgId.board.tsx",
      path: "/org/$orgId/board",
      kind: "page",
    });
    expect(fileToRoute("about.tsx")?.path).toBe("/about");
  });

  it("recognises shell files", () => {
    expect(fileToRoute("__root.tsx")?.kind).toBe("root");
    expect(fileToRoute("__404.tsx")?.kind).toBe("notFound");
    expect(fileToRoute("__error.tsx")?.kind).toBe("error");
  });

  it("ignores non-route files", () => {
    expect(fileToRoute("styles.css")).toBeNull();
    expect(fileToRoute("__weird.tsx")).toBeNull();
    expect(fileToRoute("nested/index.tsx")).toBeNull();
  });

  it("classifies .ts files as HTTP routes (route()), incl. catch-all", () => {
    expect(fileToRoute("api.auth.$.ts")).toEqual({
      file: "api.auth.$.ts",
      path: "/api/auth/$",
      kind: "http",
    });
    expect(fileToRoute("api.webhooks.stripe.ts")).toEqual({
      file: "api.webhooks.stripe.ts",
      path: "/api/webhooks/stripe",
      kind: "http",
    });
    // .tsx stays a live page even with the same base
    expect(fileToRoute("dashboard.tsx")?.kind).toBe("page");
  });

  it("converts $params to wouter patterns", () => {
    expect(pathToPattern("/org/$orgId/board")).toBe("/org/:orgId/board");
    expect(pathToPattern("/")).toBe("/");
  });
});

describe("ensurePathLiteral (§7: filename is truth)", () => {
  it("corrects a hand-edited literal", () => {
    const src = 'export default live("/wrong/path")({ setup: () => ({}) })(App);';
    expect(ensurePathLiteral(src, "/org/$orgId/board")).toBe(
      'export default live("/org/$orgId/board")({ setup: () => ({}) })(App);',
    );
  });

  it("returns null when the literal already matches", () => {
    const src = 'export default live("/ok")({})(App);';
    expect(ensurePathLiteral(src, "/ok")).toBeNull();
  });

  it("returns null for files without a live() call", () => {
    expect(ensurePathLiteral("export default 5;", "/x")).toBeNull();
  });

  it("handles single quotes", () => {
    expect(ensurePathLiteral("live('/old')({})", "/new")).toBe("live('/new')({})");
  });

  it("maintains route() literals too", () => {
    expect(ensurePathLiteral('export default route("/old").all(h);', "/api/auth/$")).toBe(
      'export default route("/api/auth/$").all(h);',
    );
    expect(ensurePathLiteral('route("/api/auth/$").all(h)', "/api/auth/$")).toBeNull();
  });
});

describe("codegen end-to-end", () => {
  const dirs: string[] = [];
  const makeProject = () => {
    const root = mkdtempSync(join(tmpdir(), "rpxd-codegen-"));
    dirs.push(root);
    return root;
  };
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it("scans, generates the typed module, and fixes literals", () => {
    const root = makeProject();
    const routes = join(root, "routes");
    writeFileSync(join(root, "package.json"), "{}");
    mkdirSync(routes);
    writeFileSync(join(routes, "index.tsx"), 'export default live("/stale")({})(App);');
    writeFileSync(
      join(routes, "org.$orgId.board.tsx"),
      'export default live("/org/$orgId/board")({})(App);',
    );
    writeFileSync(join(routes, "__root.tsx"), "export default () => null;");

    const generated = runCodegen(root);

    // literal corrected: filename is truth
    expect(readFileSync(join(routes, "index.tsx"), "utf-8")).toContain('live("/")');
    // generated module content
    expect(generated).toContain('"/org/$orgId/board"');
    expect(generated).toContain('pattern: "/org/:orgId/board"');
    expect(generated).toContain("routeModules");
    expect(generated).toContain('declare module "@rpxd/core"');
    expect(generated).toContain("Auto-generated route map — do not edit");
    expect(generated).toContain("rootModule");
    // written to .rpxd/routes.gen.ts
    expect(readFileSync(join(root, ".rpxd/routes.gen.ts"), "utf-8")).toBe(generated);
  });

  it("scanRoutes returns deterministic order", () => {
    const root = makeProject();
    const routes = join(root, "routes");
    mkdirSync(routes);
    for (const f of ["zebra.tsx", "alpha.tsx", "index.tsx"]) {
      writeFileSync(join(routes, f), "export default 1;");
    }
    expect(scanRoutes(routes).map((e) => e.path)).toEqual(["/", "/alpha", "/zebra"]);
  });

  it("generateRoutesModule handles missing shell files", () => {
    const generated = generateRoutesModule([{ file: "index.tsx", path: "/", kind: "page" }]);
    expect(generated).toContain("export const rootModule = undefined;");
    expect(generated).toContain("export const notFoundModule = undefined;");
  });

  it("keeps HTTP routes out of routes.gen.ts (client-imported); puts them in handlers.gen.ts", () => {
    const entries: RouteEntry[] = [
      { file: "index.tsx", path: "/", kind: "page" },
      { file: "api.auth.$.ts", path: "/api/auth/$", kind: "http" },
    ];
    const routes = generateRoutesModule(entries);
    // HTTP routes must NOT appear in the client-imported module at all.
    expect(routes).not.toContain("routeHandlers");
    expect(routes).not.toContain("/api/auth/$");

    const handlers = generateHandlersModule(entries);
    expect(handlers).toContain("export const routeHandlers = {");
    expect(handlers).toContain('"/api/auth/$": () => import("../routes/api.auth.$.ts")');
    expect(handlers).not.toContain("routeTree"); // server-only, not the navigable map
  });

  it("generateHandlersModule renders {} when there are no HTTP routes", () => {
    const handlers = generateHandlersModule([{ file: "index.tsx", path: "/", kind: "page" }]);
    expect(handlers).toContain("export const routeHandlers = {} as const;");
  });
});
