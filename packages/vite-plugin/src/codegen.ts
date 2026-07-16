/**
 * `.rpxd/routes.gen.ts` generation (§7, §17): typed route map + `Register`
 * interface merge, TSDoc on everything generated.
 */
import { readdirSync } from "node:fs";
import { fileToRoute, pathToPattern, type RouteEntry, sortRoutes } from "./routes.ts";
import { findPatternLiteral, type LiveModuleEntry } from "./scan.ts";

/**
 * Scan a routes directory (flat, §7) into route entries.
 *
 * @example
 * ```ts
 * scanRoutes("/app/routes"); // [{ file: "index.tsx", path: "/", kind: "page" }, ...]
 * ```
 */
export function scanRoutes(routesDir: string): RouteEntry[] {
  const entries: RouteEntry[] = [];
  // `withFileTypes` so a *directory* named like a route file (`weird.tsx/`)
  // isn't mistaken for a route.
  for (const dirent of readdirSync(routesDir, { withFileTypes: true })) {
    if (!dirent.isFile()) continue;
    const entry = fileToRoute(dirent.name);
    if (entry) entries.push(entry);
  }
  return sortRoutes(entries);
}

/**
 * A generated TS string literal, safely escaped. Route paths and filenames are
 * untrusted (the filename is whatever is on disk), so they must never be
 * spliced raw into generated source — a `"` would close the literal and inject
 * arbitrary code / break the build.
 */
function lit(value: string): string {
  return JSON.stringify(value);
}

/** Wrap map entries in braces, or `{}` when empty (a `{\n\n}` block is a format error). */
function mapBlock(entriesStr: string): string {
  return entriesStr ? `{\n${entriesStr}\n}` : "{}";
}

/**
 * Render the server-only `handlers.gen.ts` module: lazy importers for HTTP
 * `route()` files. Kept in a **separate** file the client entry never imports —
 * co-locating these dynamic imports with `routeModules` would drag every HTTP
 * route (and its server-only deps) into the client bundle (the routes & auth guide).
 *
 * @example
 * ```ts
 * const source = generateHandlersModule(scanRoutes(routesDir));
 * ```
 */
export function generateHandlersModule(
  entries: RouteEntry[],
  routesImportPrefix = "../routes",
): string {
  const httpEntries = entries
    .filter((e) => e.kind === "http" && e.path !== null)
    .map(
      (e) => `  ${lit(e.path as string)}: () => import(${lit(`${routesImportPrefix}/${e.file}`)}),`,
    )
    .join("\n");
  return `/**
 * Auto-generated server-only HTTP route map — do not edit; maintained by \`rpxd dev\`.
 * Never imported by the client entry (keeps \`route()\` handler deps server-side).
 */
export const routeHandlers = ${mapBlock(httpEntries)} as const;
`;
}

/**
 * Render the `routes.gen.ts` module for a set of entries. Pure — callers
 * decide where to write it. `routesImportPrefix` is the relative path from
 * the generated file to the routes dir (default `../routes`).
 *
 * @example
 * ```ts
 * const source = generateRoutesModule(scanRoutes(routesDir));
 * ```
 */
export function generateRoutesModule(
  entries: RouteEntry[],
  routesImportPrefix = "../routes",
): string {
  const pages = entries.filter((e) => e.kind === "page" && e.path !== null);
  const shell = (kind: RouteEntry["kind"]) => entries.find((e) => e.kind === kind);

  const treeEntries = pages
    .map((e) => {
      const pattern = pathToPattern(e.path as string);
      return `  ${lit(e.path as string)}: {\n    file: ${lit(`${routesImportPrefix}/${e.file}`)},\n    pattern: ${lit(pattern)},\n  },`;
    })
    .join("\n");

  const moduleEntries = pages
    .map(
      (e) => `  ${lit(e.path as string)}: () => import(${lit(`${routesImportPrefix}/${e.file}`)}),`,
    )
    .join("\n");

  const treeBlock = mapBlock(treeEntries);
  const modulesBlock = mapBlock(moduleEntries);

  const shellEntry = (kind: RouteEntry["kind"], name: string) => {
    const e = shell(kind);
    return e
      ? `export const ${name} = () => import(${lit(`${routesImportPrefix}/${e.file}`)});`
      : `export const ${name} = undefined;`;
  };

  return `/**
 * Auto-generated route map — do not edit; maintained by \`rpxd dev\`.
 * Provides typed paths/params for {@link Link} and \`nav.navigate\`.
 * @example <Link to="/org/$orgId/board" params={{ orgId }} />
 */
export const routeTree = ${treeBlock} as const;

/** Lazy importers for each page route — used by the client router and SSR. */
export const routeModules = ${modulesBlock} as const;

/** Shell modules (§14): HTML root, unmatched-URL page, error page. */
${shellEntry("root", "rootModule")}
${shellEntry("notFound", "notFoundModule")}
${shellEntry("error", "errorModule")}

/** All registered page paths. */
export type RegisteredPath = keyof typeof routeTree;

declare module "@rpxd/core" {
  /**
   * Route registration merge (§7): gives \`Link\`, \`useNav\`, and the \`nav\`
   * render prop typed \`to\`/\`params\` for every route in this app.
   */
  interface Register {
    routes: typeof routeTree;
  }
}
`;
}

/**
 * Escape `value` so it can be spliced between the given quote character as a
 * valid literal. Paths derive from filenames on disk, so they are untrusted:
 * a stray quote, backslash, or `${` (in a template literal) must not corrupt —
 * or inject code into — the user's source. AST spans make every path
 * splice-able (retiring the old `UNSPLICEABLE` bail-out): the string is
 * re-encoded for its quote kind rather than assumed safe.
 */
function escapeForQuote(value: string, quote: string): string {
  if (quote === "`") {
    return value
      .replace(/\\/g, "\\\\")
      .replace(/`/g, "\\`")
      .replace(/\$\{/g, "\\${")
      .replace(/\r/g, "\\r");
  }
  return value
    .replace(/\\/g, "\\\\")
    .replace(new RegExp(quote, "g"), `\\${quote}`)
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r");
}

/**
 * Maintain the in-file path literal (§7): the filename is truth, the
 * `live("...")` / `route("...")` literal is its typed mirror. Locates the
 * literal by AST span ({@link findPatternLiteral}) and splices in a correctly
 * escaped `expectedPath`, preserving the original quote style. Returns the
 * corrected source, or `null` when there is nothing to change (no
 * `live()`/`route()` call, or the literal already matches).
 *
 * @example
 * ```ts
 * ensurePathLiteral('export default live("/old")({ ... })', "/org/$orgId/board");
 * // → 'export default live("/org/$orgId/board")({ ... })'
 * ensurePathLiteral('export default route("/old").all(h)', "/api/auth/$");
 * // → 'export default route("/api/auth/$").all(h)'
 * ```
 */
export function ensurePathLiteral(source: string, expectedPath: string): string | null {
  const lit = findPatternLiteral(source);
  if (!lit) return null; // not a live/route file — nothing to maintain
  if (lit.value === expectedPath) return null;
  const replacement = `${lit.quote}${escapeForQuote(expectedPath, lit.quote)}${lit.quote}`;
  return source.slice(0, lit.start) + replacement + source.slice(lit.end);
}

/**
 * Render the server-only `live.gen.ts` module: lazy importers keyed by
 * `live(pattern)` for every exported `live()` object discovered outside the
 * routes dir (ADR 0002 item 4). Mirrors {@link generateHandlersModule} — a
 * separate file the client entry never imports. Server consumers assert
 * `$live: true` on each default export at boot, so a scan false-positive fails
 * at startup rather than at first mount.
 *
 * @example
 * ```ts
 * generateLiveModule([{ file: "src/slots/chat.tsx", path: "/chat" }]);
 * // export const liveModules = { "/chat": () => import("../src/slots/chat.tsx") } as const;
 * ```
 */
export function generateLiveModule(entries: LiveModuleEntry[], importPrefix = ".."): string {
  const liveEntries = entries
    .map((e) => `  ${lit(e.path)}: () => import(${lit(`${importPrefix}/${e.file}`)}),`)
    .join("\n");
  return `/**
 * Auto-generated live-object mount map — do not edit; maintained by \`rpxd dev\`.
 * Lazy importers keyed by \`live(pattern)\` for the control-plane mount union
 * (ADR 0002). Never imported by the client entry (keeps server-only chain deps
 * off the client). Consumers assert \`$live: true\` on each default export at boot.
 */
export const liveModules = ${mapBlock(liveEntries)} as const;
`;
}
