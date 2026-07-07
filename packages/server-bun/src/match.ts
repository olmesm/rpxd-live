/** URL-path matching against route path literals (`/org/$orgId/board`). */

export interface RouteMatch {
  path: string;
  params: Record<string, string>;
}

/**
 * Match a concrete pathname against a route path with `$param` segments.
 * Returns the captured params, or `null` when it doesn't match.
 *
 * @example
 * ```ts
 * matchPath("/org/$orgId/board", "/org/42/board"); // { orgId: "42" }
 * ```
 */
export function matchPath(routePath: string, pathname: string): Record<string, string> | null {
  const routeSegs = routePath.split("/").filter((s) => s !== "");
  const pathSegs = pathname.split("/").filter((s) => s !== "");
  if (routeSegs.length !== pathSegs.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < routeSegs.length; i++) {
    const route = routeSegs[i] as string;
    const actual = pathSegs[i] as string;
    if (route.startsWith("$")) params[route.slice(1)] = decodeURIComponent(actual);
    else if (route !== actual) return null;
  }
  return params;
}

/** Find the first matching route path in a table (static beats param by sort order). */
export function matchRoute(paths: string[], pathname: string): RouteMatch | null {
  // Prefer routes with fewer params so `/about` beats `/$slug`.
  const sorted = [...paths].sort(
    (a, b) => (a.match(/\$/g)?.length ?? 0) - (b.match(/\$/g)?.length ?? 0),
  );
  for (const path of sorted) {
    const params = matchPath(path, pathname);
    if (params) return { path, params };
  }
  return null;
}
