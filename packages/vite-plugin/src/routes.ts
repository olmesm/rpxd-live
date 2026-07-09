/**
 * File-based routing rules (§7): flat filenames, `$param` segments, URL is
 * identity. The filename is truth; the in-file path literal is its typed
 * mirror.
 */

/** One discovered route file. */
export interface RouteEntry {
  /** Path relative to the routes dir, e.g. `org.$orgId.board.tsx`. */
  file: string;
  /** URL path, e.g. `/org/$orgId/board`. `null` for shell files (kind is a shell). */
  path: string | null;
  kind: "page" | "http" | "root" | "notFound" | "error";
}

const ROUTE_EXT = /\.(tsx|jsx|ts|js)$/;

/**
 * Map a flat route filename to its URL path (§7). Extension decides the kind:
 * `.tsx`/`.jsx` export `live()` (a page), `.ts`/`.js` export `route()` (an
 * HTTP endpoint) — see the routes & auth guide.
 *
 * - `index.tsx` → `/` (page)
 * - `org.$orgId.board.tsx` → `/org/$orgId/board` (page)
 * - `api.auth.$.ts` → `/api/auth/$` (http, `$` = catch-all)
 * - `__root.tsx` / `__404.tsx` / `__error.tsx` → shell files, no URL
 * - non-route files (no recognised extension) → `null`
 *
 * @example
 * ```ts
 * fileToRoute("org.$orgId.board.tsx");
 * // { file: "org.$orgId.board.tsx", path: "/org/$orgId/board", kind: "page" }
 * fileToRoute("api.auth.$.ts");
 * // { file: "api.auth.$.ts", path: "/api/auth/$", kind: "http" }
 * ```
 */
export function fileToRoute(file: string): RouteEntry | null {
  const extMatch = ROUTE_EXT.exec(file);
  if (!extMatch || file.includes("/")) return null;
  const base = file.slice(0, extMatch.index);
  if (base === "__root") return { file, path: null, kind: "root" };
  if (base === "__404") return { file, path: null, kind: "notFound" };
  if (base === "__error") return { file, path: null, kind: "error" };
  if (base.startsWith("__")) return null; // unknown shell file — ignore
  const ext = extMatch[1] as string;
  const kind = ext === "tsx" || ext === "jsx" ? "page" : "http";
  const path = base === "index" ? "/" : `/${base.split(".").join("/")}`;
  return { file, path, kind };
}

/**
 * Convert a route path to the wouter pattern it matches (`$x` → `:x`).
 *
 * @example
 * ```ts
 * pathToPattern("/org/$orgId/board"); // "/org/:orgId/board"
 * ```
 */
export function pathToPattern(path: string): string {
  return path
    .split("/")
    .map((seg) => (seg.startsWith("$") ? `:${seg.slice(1)}` : seg))
    .join("/");
}

/**
 * Sort pages for deterministic output: static segments before params, then alpha.
 *
 * @example
 * ```ts
 * sortRoutes(entries).map((e) => e.path); // ["/", "/about", "/org/$orgId"]
 * ```
 */
export function sortRoutes(entries: RouteEntry[]): RouteEntry[] {
  return [...entries].sort((a, b) => (a.path ?? "").localeCompare(b.path ?? ""));
}
