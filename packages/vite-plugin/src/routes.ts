/**
 * File-based routing rules (§7): flat filenames, `$param` segments, URL is
 * identity. The filename is truth; the in-file path literal is its typed
 * mirror.
 */

/** One discovered route file. */
export interface RouteEntry {
  /** Path relative to the routes dir, e.g. `org.$orgId.board.tsx`. */
  file: string;
  /** URL path, e.g. `/org/$orgId/board`. `null` for shell files (kind !== "page"). */
  path: string | null;
  kind: "page" | "root" | "notFound" | "error";
}

const ROUTE_EXT = /\.(tsx|jsx|ts|js)$/;

/**
 * Map a flat route filename to its URL path (§7).
 *
 * - `index.tsx` → `/`
 * - `org.$orgId.board.tsx` → `/org/$orgId/board`
 * - `__root.tsx` / `__404.tsx` / `__error.tsx` → shell files, no URL
 * - non-route files (no recognised extension) → `null`
 *
 * @example
 * ```ts
 * fileToRoute("org.$orgId.board.tsx");
 * // { file: "org.$orgId.board.tsx", path: "/org/$orgId/board", kind: "page" }
 * ```
 */
export function fileToRoute(file: string): RouteEntry | null {
  if (!ROUTE_EXT.test(file) || file.includes("/")) return null;
  const base = file.replace(ROUTE_EXT, "");
  if (base === "__root") return { file, path: null, kind: "root" };
  if (base === "__404") return { file, path: null, kind: "notFound" };
  if (base === "__error") return { file, path: null, kind: "error" };
  if (base.startsWith("__")) return null; // unknown shell file — ignore
  if (base === "index") return { file, path: "/", kind: "page" };
  return { file, path: `/${base.split(".").join("/")}`, kind: "page" };
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
