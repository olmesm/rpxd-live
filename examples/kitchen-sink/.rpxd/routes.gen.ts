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
  "/account": {
    file: "../routes/account.tsx",
    pattern: "/account",
  },
  "/boom": {
    file: "../routes/boom.tsx",
    pattern: "/boom",
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
  "/item/$id": {
    file: "../routes/item.$id.tsx",
    pattern: "/item/:id",
  },
  "/login": {
    file: "../routes/login.tsx",
    pattern: "/login",
  },
  "/stream": {
    file: "../routes/stream.tsx",
    pattern: "/stream",
  },
} as const;

/** Lazy importers for each page route — used by the client router and SSR. */
export const routeModules = {
  "/": () => import("../routes/index.tsx"),
  "/account": () => import("../routes/account.tsx"),
  "/boom": () => import("../routes/boom.tsx"),
  "/chat": () => import("../routes/chat.tsx"),
  "/doc": () => import("../routes/doc.tsx"),
  "/import": () => import("../routes/import.tsx"),
  "/item/$id": () => import("../routes/item.$id.tsx"),
  "/login": () => import("../routes/login.tsx"),
  "/stream": () => import("../routes/stream.tsx"),
} as const;

/** Shell modules (§14): HTML root, unmatched-URL page, error page. */
export const rootModule = () => import("../routes/__root.tsx");
export const notFoundModule = () => import("../routes/__404.tsx");
export const errorModule = () => import("../routes/__error.tsx");

/**
 * The persistent region (ADR 0002 item 13): `__layout.tsx`, rendered inside
 * `RpxdProvider` but outside `key={pathname}`. Mounted once per app session,
 * it survives every navigation and may host `<LiveSlot>`s. `undefined` when
 * the app has no `__layout.tsx` (layout-less parity).
 */
export const layoutModule = () => import("../routes/__layout.tsx");

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
