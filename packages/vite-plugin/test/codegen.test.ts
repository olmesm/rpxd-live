import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ensurePathLiteral,
  generateHandlersModule,
  generateLiveModule,
  generateRoutesModule,
  scanRoutes,
} from "../src/codegen.ts";
import { isRouteFilePath, runCodegen } from "../src/index.ts";
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
    // ADR 0002 item 13: the persistent region — a shell file, no URL.
    expect(fileToRoute("__layout.tsx")).toEqual({
      file: "__layout.tsx",
      path: null,
      kind: "layout",
    });
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

  it("safely escapes paths with quotes/backslashes when splicing (span-based)", () => {
    // AST spans retire the old UNSPLICEABLE bail-out: the literal is re-encoded
    // for its quote kind, so a crafted path becomes a *safe* string literal
    // (never executable code), preserving the original quote style.
    // A file named `it's.tsx` derives "/it's" — the apostrophe is escaped for
    // the single-quote literal, not left to break the file.
    expect(ensurePathLiteral("live('/old')({})", "/it's")).toBe("live('/it\\'s')({})");
    // An injection-shaped filename splices as an escaped, inert string literal.
    expect(ensurePathLiteral('export default route("/old").all(h);', '/x") || evil() || ("y')).toBe(
      'export default route("/x\\") || evil() || (\\"y").all(h);',
    );
    // A backslash doubles rather than escaping the closing quote.
    expect(ensurePathLiteral('live("/old")({})', "/back\\slash")).toBe(
      'live("/back\\\\slash")({})',
    );
    // A `${` inside a *double*-quoted literal is inert — spliced verbatim.
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the literal `${` is the input under test
    expect(ensurePathLiteral('live("/old")({})', "/tick`${evil}")).toBe(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: verbatim expected output
      'live("/tick`${evil}")({})',
    );
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
    // ADR 0002 item 13: absent __layout → undefined (layout-less parity).
    expect(generated).toContain("export const layoutModule = undefined;");
  });

  it("generateRoutesModule emits a layoutModule importer when __layout is present (ADR 0002 item 13)", () => {
    const generated = generateRoutesModule([
      { file: "index.tsx", path: "/", kind: "page" },
      { file: "__layout.tsx", path: null, kind: "layout" },
    ]);
    expect(generated).toContain(
      'export const layoutModule = () => import("../routes/__layout.tsx");',
    );
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

  it("generateLiveModule emits lazy importers keyed by pattern (escaped via lit)", () => {
    const live = generateLiveModule([
      { file: "src/slots/chat.tsx", path: "/chat" },
      { file: 'ev"il.tsx', path: '/ev"il' },
    ]);
    expect(live).toContain("export const liveModules = {");
    expect(live).toContain('"/chat": () => import("../src/slots/chat.tsx"),');
    // crafted pattern/file are JSON-escaped, never spliced raw
    expect(live).not.toContain('"/ev"il"');
    expect(live).toContain(JSON.stringify('/ev"il'));
    expect(live).toContain(JSON.stringify('../ev"il.tsx'));
    expect(live).toContain("do not edit");
  });

  it("generateLiveModule renders {} when there are no scanned live modules", () => {
    expect(generateLiveModule([])).toContain("export const liveModules = {} as const;");
  });

  it("keeps routes.gen.ts byte-identical for a slot-free project + emits empty live.gen.ts", () => {
    const root = makeProject();
    const routes = join(root, "routes");
    writeFileSync(join(root, "package.json"), "{}");
    mkdirSync(routes);
    writeFileSync(join(routes, "index.tsx"), 'export default live("/")({})(App);');
    writeFileSync(
      join(routes, "org.$orgId.board.tsx"),
      'export default live("/org/$orgId/board")({})(App);',
    );
    // a non-live source file outside routes must not perturb output
    mkdirSync(join(root, "domain"));
    writeFileSync(join(root, "domain/todos.ts"), "export const listTodos = () => [];");

    const generated = runCodegen(root);
    // routes.gen.ts is exactly generateRoutesModule's output (unchanged codegen)
    expect(readFileSync(join(root, ".rpxd/routes.gen.ts"), "utf-8")).toBe(
      generateRoutesModule(scanRoutes(routes)),
    );
    expect(generated).toBe(generateRoutesModule(scanRoutes(routes)));
    // live.gen.ts exists and is empty (no out-of-routes live modules)
    expect(readFileSync(join(root, ".rpxd/live.gen.ts"), "utf-8")).toBe(generateLiveModule([]));
  });

  it("escapes route paths/files so a crafted filename can't inject code", () => {
    // A filename containing a double-quote would otherwise close the string
    // literal and splice arbitrary text into the generated module.
    const entries: RouteEntry[] = [{ file: 'ev"il.tsx', path: '/ev"il', kind: "page" }];
    const routes = generateRoutesModule(entries);
    // The raw, unescaped literal must not appear...
    expect(routes).not.toContain('"/ev"il"');
    // ...it must be JSON-escaped instead.
    expect(routes).toContain(JSON.stringify('/ev"il'));
    expect(routes).toContain(JSON.stringify('../routes/ev"il.tsx'));

    const httpEntries: RouteEntry[] = [{ file: 'ev"il.ts', path: '/ev"il', kind: "http" }];
    const handlers = generateHandlersModule(httpEntries);
    expect(handlers).not.toContain('"/ev"il"');
    expect(handlers).toContain(JSON.stringify('/ev"il'));
  });

  it("escapes crafted filenames when rewriting literals (span-based)", () => {
    const root = makeProject();
    const routes = join(root, "routes");
    writeFileSync(join(root, "package.json"), "{}");
    mkdirSync(routes);
    const src = 'export default live("/old")({})(App);';
    writeFileSync(join(routes, "it's.tsx"), src);
    writeFileSync(join(routes, 'x") || evil() || ("y.tsx'), src);

    runCodegen(root);

    // Filename is truth: the literal is rewritten to match, with any quote /
    // backslash escaped for the literal — a safe string, never injected code.
    expect(readFileSync(join(routes, "it's.tsx"), "utf-8")).toBe(
      'export default live("/it\'s")({})(App);',
    );
    expect(readFileSync(join(routes, 'x") || evil() || ("y.tsx'), "utf-8")).toBe(
      'export default live("/x\\") || evil() || (\\"y")({})(App);',
    );
  });

  it("registers out-of-routes live modules into live.gen.ts", () => {
    const root = makeProject();
    const routes = join(root, "routes");
    writeFileSync(join(root, "package.json"), "{}");
    mkdirSync(routes);
    writeFileSync(join(routes, "index.tsx"), 'export default live("/")({})(App);');
    mkdirSync(join(root, "src"));
    writeFileSync(
      join(root, "src/chat.tsx"),
      'import { live } from "@rpxd/core";\nexport default live("/chat").render(() => null);',
    );

    runCodegen(root);
    const live = readFileSync(join(root, ".rpxd/live.gen.ts"), "utf-8");
    expect(live).toContain('"/chat": () => import("../src/chat.tsx"),');
    // routes.gen.ts stays the navigable-page map only
    const routesGen = readFileSync(join(root, ".rpxd/routes.gen.ts"), "utf-8");
    expect(routesGen).not.toContain("/chat");
  });

  it("errors when a slot pattern collides with a routes-dir page, naming both files", () => {
    const root = makeProject();
    const routes = join(root, "routes");
    writeFileSync(join(root, "package.json"), "{}");
    mkdirSync(routes);
    writeFileSync(join(routes, "chat.tsx"), 'export default live("/chat")({})(App);');
    mkdirSync(join(root, "src"));
    writeFileSync(
      join(root, "src/chat.tsx"),
      'import { live } from "@rpxd/core";\nexport default live("/chat").render(() => null);',
    );

    let caught: unknown;
    try {
      runCodegen(root);
    } catch (e) {
      caught = e;
    }
    const msg = (caught as Error | undefined)?.message ?? "";
    expect(msg).toContain("routes/chat.tsx");
    expect(msg).toContain("src/chat.tsx");
    expect(msg).toContain("/chat");
  });

  it("scanRoutes ignores directories that look like route files", () => {
    const root = makeProject();
    const routes = join(root, "routes");
    mkdirSync(routes);
    writeFileSync(join(routes, "index.tsx"), "export default 1;");
    mkdirSync(join(routes, "weird.tsx")); // a *directory* named like a route file
    expect(scanRoutes(routes).map((e) => e.path)).toEqual(["/"]);
  });
});

describe("isRouteFilePath (watcher predicate, §7)", () => {
  it("matches only files under the routes dir, with a separator boundary", () => {
    const routes = join(tmpdir(), "app", "routes");
    expect(isRouteFilePath(join(routes, "index.tsx"), routes)).toBe(true);
    // a sibling dir sharing the string prefix must NOT match
    expect(isRouteFilePath(join(tmpdir(), "app", "routes-backup", "index.tsx"), routes)).toBe(
      false,
    );
    // non-route extension inside the dir
    expect(isRouteFilePath(join(routes, "styles.css"), routes)).toBe(false);
  });
});
