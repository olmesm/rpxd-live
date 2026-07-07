/**
 * Auto-generated route map — do not edit; maintained by `rpxd dev`.
 * Provides typed paths/params for {@link Link} and `nav.navigate`.
 * @example <Link to="/org/$orgId/board" params={{ orgId }} />
 */
export const routeTree = {} as const;

/** Lazy importers for each page route — used by the client router and SSR. */
export const routeModules = {} as const;

/** Shell modules (§14): HTML root, unmatched-URL page, error page. */
export const rootModule = undefined;
export const notFoundModule = undefined;
export const errorModule = undefined;

/** All registered page paths. */
export type RegisteredPath = keyof typeof routeTree;

declare module "@rpxd/core" {
  /**
   * Route registration merge (§7): gives `Link`, `useNav`, and the `nav`
   * render prop typed `to`/`params` for every route in this app.
   */
  interface Register {
    routes: typeof routeTree;
  }
}
