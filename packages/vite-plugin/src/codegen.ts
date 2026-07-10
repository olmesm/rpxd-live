/**
 * `.rpxd/routes.gen.ts` generation (§7, §17): typed route map + `Register`
 * interface merge, TSDoc on everything generated.
 */
import { readdirSync } from "node:fs";
import { fileToRoute, pathToPattern, type RouteEntry, sortRoutes } from "./routes.ts";

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

const PATH_CALL = /(\b(?:live|route)\s*\(\s*)(["'])((?:[^"'\\]|\\.)*)\2(\s*\))/;

/**
 * Characters that cannot be spliced raw between the existing quote characters
 * of a `live()`/`route()` literal: a quote or backslash would corrupt (or, for
 * a crafted filename, inject code into) the *user's* source file, and `${`
 * would interpolate if the file ever uses a template literal. Paths come from
 * filenames on disk, so they are as untrusted as {@link lit}'s inputs.
 */
const UNSPLICEABLE = /["'`\\]|\$\{/;

/**
 * Maintain the in-file path literal (§7): the filename is truth, the
 * `live("...")` / `route("...")` literal is its typed mirror. Returns the
 * corrected source when the literal is missing/incorrect, or `null` when
 * nothing changed — including when `expectedPath` contains characters that
 * can't be spliced into a quoted literal (see {@link UNSPLICEABLE}).
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
  if (UNSPLICEABLE.test(expectedPath)) return null; // unspliceable path — leave the file alone
  const match = PATH_CALL.exec(source);
  if (!match) return null; // not a live/route file — nothing to maintain
  if (match[3] === expectedPath) return null;
  // Function replacer: `expectedPath` may contain `$` (catch-all/`$param`),
  // which a string replacement would mis-read as a backreference.
  return source.replace(
    PATH_CALL,
    (_m, pre, quote, _old, post) => `${pre}${quote}${expectedPath}${quote}${post}`,
  );
}
