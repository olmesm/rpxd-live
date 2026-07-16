/**
 * SPA navigation runtime (§7, ADR 0002 item 9): renders the current route and
 * swaps the route + component on location changes — soft navigation, no page
 * load. Path params are identity; a path change is a soft reload. Every tier
 * remounts a fresh page instance over ONE app-lifetime connection and rebinds
 * the primary store to it (tier 3 = tier 2 + component swap); the transport and
 * app shell — including any layout slots multiplexed on the same stream —
 * survive. The previous page stays interactive until the next state arrives.
 */
import {
  createElement,
  type FunctionComponent,
  type ReactElement,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from "react";
import { useLocation } from "wouter";
import { navigate } from "wouter/use-browser-location";
import type { LiveConnection } from "./connection.ts";
import {
  type AnyConnection,
  type AnyRoute,
  type CurrentPage,
  claimNavigationTicket,
  performNavigation,
  popstateSearchPatch,
} from "./navigation.ts";
import { useLiveStore } from "./react.ts";
import { RpxdProvider, useNav } from "./router.tsx";

/** Props for {@link LiveApp} — wired up by the generated client entry. */
export interface LiveAppProps {
  /** The SSR'd page's route object. */
  route: AnyRoute;
  /** Connection attached to the SSR'd instance (§12). */
  // biome-ignore lint/suspicious/noExplicitAny: accepts any route's connection
  connection: LiveConnection<any, any>;
  /** Lazy route-module table from `.rpxd/routes.gen.ts`. */
  routeModules: Record<string, () => Promise<{ default: AnyRoute }>>;
  /**
   * Transport (§11) — the generated entry bakes it into {@link connection} at
   * construction; carried here for parity/back-compat since navigation now
   * reuses the app-lifetime connection rather than building one (ADR item 9).
   */
  transport?: "sse" | "ws";
  /** Optional state transform before render (RSC field hydration, §16). */
  transformState?: (state: unknown) => unknown;
  /**
   * The persistent region (ADR 0002 item 13) — `__layout.tsx`'s default export,
   * threaded through by the generated client entry. Rendered inside
   * {@link RpxdProvider} but **outside** `key={pathname}`, so it mounts once per
   * app session and survives every navigation (tier 1/2/3): its React state and
   * any `<LiveSlot>` it hosts (an agent chat panel, Decision 5) keep painting
   * across page swaps. It receives the current page as `children`. Reaches the
   * connection and `useNav` via the provider it lives inside. `undefined` (the
   * default) renders the page directly — byte-identical to a layout-less app.
   */
  layout?: FunctionComponent<{ children?: ReactNode }>;
}

/**
 * The framework's client shell (§7, ADR 0002 item 9): one live page at a time,
 * soft-swapped on navigation over ONE app-lifetime connection. `Link`/
 * `nav.navigate` push history; this component matches the new pathname against
 * the route table, remounts the new page instance over the existing live stream
 * (tier 3 = tier 2 + component swap), waits for its snapshot, then swaps route +
 * pathname — the connection is never closed on navigation, so a layout slot's
 * stream survives every page change. Unmatched paths fall back to a full page
 * load so the server's 404/error pages stay authoritative.
 *
 * @example
 * ```tsx
 * hydrateRoot(rootEl, <LiveApp route={route} connection={conn} routeModules={routeModules} />);
 * ```
 */
export function LiveApp(props: LiveAppProps): ReactElement {
  const [current, setCurrent] = useState<CurrentPage>(() => ({
    pathname: typeof window !== "undefined" ? window.location.pathname : props.route.path,
    route: props.route,
    conn: props.connection as AnyConnection,
  }));
  const ticket = useRef(0);
  const [location] = useLocation();

  // Runtime redirects (§10) — a `guard`/`load` deny during `nav.patch` or a
  // tier-2 remount — soft-nav via the router. The SSR connection is built by
  // generated code without this sink, so install it here.
  useEffect(() => {
    current.conn.setRedirectSink((loc) => navigate(loc));
  }, [current.conn]);

  // Popstate between two search-variants of one path is invisible to wouter
  // (its location is pathname-only), so the navigation effect below never
  // runs: reconcile guard/load over the live connection (tier 1, §7) here.
  useEffect(() => {
    const onPopState = () => {
      const patch = popstateSearchPatch(
        window.location.pathname,
        window.location.search,
        current.pathname,
        current.conn.hasPropsSchema,
      );
      if (patch) current.conn.patchProps(patch);
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [current.pathname, current.conn]);

  useEffect(() => {
    const pathname = location.split("?")[0] ?? location;
    const my = claimNavigationTicket(ticket, pathname, current.pathname);
    if (my === null) return;
    const search = Object.fromEntries(new URLSearchParams(window.location.search)) as Record<
      string,
      string
    >;
    void performNavigation({
      pathname,
      search,
      my,
      ticket,
      // One app-lifetime connection (ADR 0002 item 9): every navigation remounts
      // over it — tier 3 no longer builds (or closes) a connection.
      conn: current.conn,
      routeModules: props.routeModules,
      commit: (page) => setCurrent(page),
      softNavigate: navigate,
      hardLoad: (url) => window.location.assign(url),
    });
  }, [location, current.pathname, current.conn, props.routeModules]);

  // The page is keyed by pathname so every navigation remounts it; the layout
  // (ADR 0002 item 13) wraps it OUTSIDE that key, so React preserves the layout
  // instance across page swaps while the page below it remounts.
  const page = (
    <LivePage
      key={current.pathname}
      route={current.route}
      conn={current.conn}
      transformState={props.transformState}
    />
  );
  const Layout = props.layout;
  return (
    <RpxdProvider connection={current.conn}>{Layout ? <Layout>{page}</Layout> : page}</RpxdProvider>
  );
}

function LivePage(props: {
  route: AnyRoute;
  conn: AnyConnection;
  transformState?: (state: unknown) => unknown;
}): ReactElement {
  const snap = useLiveStore(props.conn.store);
  const nav = useNav();
  return createElement(props.route.component, {
    state: props.transformState ? props.transformState(snap.state) : snap.state,
    session: snap.session ?? {},
    sync: snap.sync,
    status: snap.status,
    keyOf: snap.keyOf,
    rpc: props.conn.store.rpc,
    nav,
  });
}
