/**
 * Auto-generated route map — do not edit; maintained by `rpxd dev`.
 * Provides typed paths/params for {@link Link} and `nav.navigate`.
 * @example <Link to="/org/$orgId/board" params={{ orgId }} />
 */
export const routeTree = {
  "/": {
    file: "../routes/index.tsx",
    pattern: "/",
  },
  "/chat": {
    file: "../routes/chat.tsx",
    pattern: "/chat",
  },
  "/doc": {
    file: "../routes/doc.tsx",
    pattern: "/doc",
  },
  "/import": {
    file: "../routes/import.tsx",
    pattern: "/import",
  },
} as const;

/** Lazy importers for each page route — used by the client router and SSR. */
export const routeModules = {
  "/": () => import("../routes/index.tsx"),
  "/chat": () => import("../routes/chat.tsx"),
  "/doc": () => import("../routes/doc.tsx"),
  "/import": () => import("../routes/import.tsx"),
} as const;

/** Shell modules (§14): HTML root, unmatched-URL page, error page. */
export const rootModule = undefined;
export const notFoundModule = undefined;
export const errorModule = undefined;

/** All registered page paths. */
export type RegisteredPath = keyof typeof routeTree;

declare module "@rpxd/client" {
  /**
   * Route registration merge (§7): gives `Link` and `nav.navigate` typed
   * `to`/`params` for every route in this app.
   */
  interface Register {
    routes: typeof routeTree;
  }
}
