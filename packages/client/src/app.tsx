/**
 * SPA navigation runtime (§7): renders the current route and swaps route +
 * connection on location changes — soft navigation, no page load. Path params
 * are identity; a path change is a soft reload. When the new path matches the
 * *same* route pattern (tier 2), the connection is reused — a fresh instance is
 * mounted over the live stream and the store rebinds to it; the SSE transport
 * and app shell survive. A *different* pattern (tier 3) swaps the connection and
 * component. The previous page stays interactive until the next state arrives.
 */
import { createElement, type ReactElement, useEffect, useRef, useState } from "react";
import { useLocation } from "wouter";
import { navigate } from "wouter/use-browser-location";
import { LiveConnection } from "./connection.ts";
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
  /** Transport for post-navigation mounts (§11). */
  transport?: "sse" | "ws";
  /** Optional state transform before render (RSC field hydration, §16). */
  transformState?: (state: unknown) => unknown;
}

/**
 * The framework's client shell (§7): one live page at a time, soft-swapped
 * on navigation. `Link`/`nav.navigate` push history; this component matches
 * the new pathname against the route table, mounts the live object over the
 * control channel, waits for its snapshot, then swaps route + connection
 * and closes the old one. Unmatched paths fall back to a full page load so
 * the server's 404/error pages stay authoritative.
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
      currentRoutePath: current.route.path,
      conn: current.conn,
      routeModules: props.routeModules,
      transport: props.transport,
      mount: (p, s, o) => LiveConnection.mount(p, s, o),
      commit: (page, closePrevious) =>
        setCurrent((prev) => {
          if (closePrevious) prev.conn.close();
          return page;
        }),
      softNavigate: navigate,
      hardLoad: (url) => window.location.assign(url),
    });
  }, [
    location,
    current.pathname,
    current.conn,
    current.route.path,
    props.routeModules,
    props.transport,
  ]);

  return (
    <RpxdProvider connection={current.conn}>
      <LivePage
        key={current.pathname}
        route={current.route}
        conn={current.conn}
        transformState={props.transformState}
      />
    </RpxdProvider>
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
