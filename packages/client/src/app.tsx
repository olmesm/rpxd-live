/**
 * SPA navigation runtime (§7): renders the current route and swaps route +
 * connection on location changes — soft navigation, no page load. Path
 * params are identity, so every path change is a fresh server mount; the
 * previous page stays interactive until the next one's state arrives.
 */
import { type LiveRoute, matchRoute } from "@rpxd/core";
import {
  createElement,
  type FunctionComponent,
  type ReactElement,
  useEffect,
  useRef,
  useState,
} from "react";
import { useLocation } from "wouter";
import { LiveConnection } from "./connection.ts";
import { useLiveStore } from "./react.ts";
import { RpxdProvider, useNav } from "./router.tsx";
import { rpcMetaFromDef } from "./store.ts";

// biome-ignore lint/suspicious/noExplicitAny: the app hosts routes of any state shape
type AnyRoute = LiveRoute<any, string, any, FunctionComponent<any>>;
type AnyConnection = LiveConnection<unknown, Record<string, unknown>>;

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

interface CurrentPage {
  pathname: string;
  route: AnyRoute;
  conn: AnyConnection;
}

/** Resolve once the store holds confirmed state (first full envelope, §2). */
function stateReady(conn: AnyConnection): Promise<void> {
  return new Promise((resolve) => {
    if (conn.store.confirmed !== undefined) return resolve();
    const unsub = conn.store.subscribe(() => {
      if (conn.store.confirmed !== undefined) {
        unsub();
        resolve();
      }
    });
  });
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

  useEffect(() => {
    const pathname = location.split("?")[0] ?? location;
    if (pathname === current.pathname) return;
    const my = ++ticket.current;
    const search = Object.fromEntries(new URLSearchParams(window.location.search)) as Record<
      string,
      string
    >;
    void (async () => {
      const match = matchRoute(Object.keys(props.routeModules), pathname);
      const load = match && props.routeModules[match.path];
      if (!load) {
        window.location.assign(location); // server renders __404
        return;
      }
      try {
        const mod = await load();
        const conn = await LiveConnection.mount(pathname, search, {
          meta: rpcMetaFromDef(mod.default.def),
          transport: props.transport,
        });
        await stateReady(conn);
        if (ticket.current !== my) {
          conn.close(); // superseded by a later navigation
          return;
        }
        setCurrent((prev) => {
          prev.conn.close();
          return { pathname, route: mod.default, conn };
        });
      } catch (e) {
        console.error("[rpxd] soft navigation failed, falling back to full load:", e);
        window.location.assign(location);
      }
    })();
  }, [location, current.pathname, props.routeModules, props.transport]);

  return (
    <RpxdProvider connection={current.conn}>
      <LivePage route={current.route} conn={current.conn} transformState={props.transformState} />
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
