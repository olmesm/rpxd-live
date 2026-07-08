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
  for (const file of readdirSync(routesDir)) {
    const entry = fileToRoute(file);
    if (entry) entries.push(entry);
  }
  return sortRoutes(entries);
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
      return `  "${e.path}": {\n    file: "${routesImportPrefix}/${e.file}",\n    pattern: "${pattern}",\n  },`;
    })
    .join("\n");

  const moduleEntries = pages
    .map((e) => `  "${e.path}": () => import("${routesImportPrefix}/${e.file}"),`)
    .join("\n");

  const http = entries.filter((e) => e.kind === "http" && e.path !== null);
  const httpEntries = http
    .map((e) => `  "${e.path}": () => import("${routesImportPrefix}/${e.file}"),`)
    .join("\n");
  // Render an empty map inline as `{}` — a `{\n\n}` block is a format violation
  // (an app with no pages, or no HTTP routes, would otherwise emit one).
  const block = (entriesStr: string) => (entriesStr ? `{\n${entriesStr}\n}` : "{}");
  const treeBlock = block(treeEntries);
  const modulesBlock = block(moduleEntries);
  const httpBlock = block(httpEntries);

  const shellEntry = (kind: RouteEntry["kind"], name: string) => {
    const e = shell(kind);
    return e
      ? `export const ${name} = () => import("${routesImportPrefix}/${e.file}");`
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

/**
 * Lazy importers for server-only HTTP routes (\`route()\`, docs/routes-and-auth.md).
 * Kept out of \`routeModules\`/\`routeTree\` — never navigable, never SSR'd.
 */
export const routeHandlers = ${httpBlock} as const;

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
 * Maintain the in-file path literal (§7): the filename is truth, the
 * `live("...")` / `route("...")` literal is its typed mirror. Returns the
 * corrected source when the literal is missing/incorrect, or `null` when
 * nothing changed.
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
