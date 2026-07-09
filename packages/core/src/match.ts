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

/**
 * Find the first matching route path in a table (static beats param by sort order).
 *
 * @example
 * ```ts
 * matchRoute(["/about", "/$slug"], "/about"); // { path: "/about", params: {} }
 * matchRoute(["/org/$orgId"], "/org/acme");   // { path: "/org/$orgId", params: { orgId: "acme" } }
 * ```
 */
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

/**
 * Match an HTTP route path (the routes & auth guide) against a pathname.
 * Like {@link matchPath}, `$name` captures one segment — but a **trailing bare
 * `$`** is a catch-all that matches the prefix and everything under it
 * (possibly nothing), capturing the rest under `params.$`. Kept separate from
 * {@link matchPath} so live-page/client matching is untouched.
 *
 * @example
 * ```ts
 * matchHttpPath("/api/auth/$", "/api/auth/sign-in"); // { "$": "sign-in" }
 * matchHttpPath("/api/auth/$", "/api/auth");          // { "$": "" }
 * matchHttpPath("/hook/$id", "/hook/42");             // { id: "42" }
 * ```
 */
export function matchHttpPath(routePath: string, pathname: string): Record<string, string> | null {
  const routeSegs = routePath.split("/").filter((s) => s !== "");
  const pathSegs = pathname.split("/").filter((s) => s !== "");
  const params: Record<string, string> = {};
  const catchAll = routeSegs[routeSegs.length - 1] === "$";
  const fixed = catchAll ? routeSegs.slice(0, -1) : routeSegs;
  if (catchAll ? pathSegs.length < fixed.length : pathSegs.length !== fixed.length) return null;
  for (let i = 0; i < fixed.length; i++) {
    const route = fixed[i] as string;
    const actual = pathSegs[i] as string;
    if (route.startsWith("$")) params[route.slice(1)] = decodeURIComponent(actual);
    else if (route !== actual) return null;
  }
  if (catchAll) {
    params.$ = pathSegs.slice(fixed.length).map(decodeURIComponent).join("/");
  }
  return params;
}

/**
 * Find the first matching HTTP route in a table. Static routes beat params,
 * and catch-all routes are tried last, so `/api/health` wins over
 * `/api/$rest` wins over `/api/$`.
 *
 * @example
 * ```ts
 * matchHttpRoute(["/api/$"], "/api/auth/x"); // { path: "/api/$", params: { "$": "auth/x" } }
 * ```
 */
export function matchHttpRoute(paths: string[], pathname: string): RouteMatch | null {
  const rank = (p: string) =>
    (p.endsWith("/$") || p === "/$" ? 1000 : 0) + (p.match(/\$/g)?.length ?? 0);
  const sorted = [...paths].sort((a, b) => rank(a) - rank(b));
  for (const path of sorted) {
    const params = matchHttpPath(path, pathname);
    if (params) return { path, params };
  }
  return null;
}
