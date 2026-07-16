/**
 * Navigation-effect decision logic (§7), extracted from the app shell so the
 * ticket discipline (latest navigation wins) and the mount/remount/fallback
 * state machine are unit-testable without a DOM. {@link LiveApp} wires the
 * browser io: wouter for soft navigation, `window.location` for hard loads.
 */
import { isRedirect, type LiveRoute, matchRoute } from "@rpxd/core";
import type { FunctionComponent } from "react";
import type { LiveConnection } from "./connection.ts";
import { rpcMetaFromDef } from "./store.ts";

/** A route of any state shape — the app shell hosts all of them. */
// biome-ignore lint/suspicious/noExplicitAny: the app hosts routes of any state shape
export type AnyRoute = LiveRoute<any, string, any, FunctionComponent<any>>;

/** A connection of any route's state shape — the app shell swaps them on navigation. */
export type AnyConnection = LiveConnection<unknown, Record<string, unknown>>;

/** One mounted live page — what the app shell renders and swaps on navigation (§7). */
export interface CurrentPage {
  pathname: string;
  route: AnyRoute;
  conn: AnyConnection;
}

/**
 * Claim a navigation ticket for a location change.
 *
 * The counter is bumped even when the target *is* the current pathname —
 * navigating back to the page on screen must invalidate any in-flight forward
 * mount, or its superseded commit would flash the wrong page — but only a
 * real path change returns a ticket to navigate with; `null` means there is
 * nothing to mount.
 *
 * @example
 * ```ts
 * const my = claimNavigationTicket(ticket, pathname, current.pathname);
 * if (my !== null) void performNavigation({ my, ticket, ... });
 * ```
 */
export function claimNavigationTicket(
  ticket: { current: number },
  pathname: string,
  currentPathname: string,
): number | null {
  const my = ++ticket.current;
  return pathname === currentPathname ? null : my;
}

/**
 * Decide what a popstate event means for search reconciliation (§7). Wouter's
 * location is pathname-only, so popstate between two search-variants of one
 * path never reruns the app shell's effect — `guard`/`load` would not see the
 * restored query. Returns the full search record to reconcile via
 * `patchProps` (tier 1) when the pathname is unchanged; `null` on a pathname
 * change, which the location effect owns.
 *
 * @example
 * ```ts
 * const patch = popstateSearchPatch(location.pathname, location.search, current.pathname);
 * if (patch) conn.patchProps(patch);
 * ```
 */
export function popstateSearchPatch(
  pathname: string,
  search: string,
  currentPathname: string,
): Record<string, string> | null {
  if (pathname !== currentPathname) return null;
  return Object.fromEntries(new URLSearchParams(search)) as Record<string, string>;
}

/**
 * Injected io for {@link performNavigation} — {@link LiveApp} supplies the
 * browser/React implementations; tests supply fakes.
 */
export interface NavigationIo {
  /** Target pathname (wouter's location — pathname only, §7). */
  pathname: string;
  /** Target search params, parsed from the URL bar. */
  search: Record<string, string>;
  /** This navigation's ticket from {@link claimNavigationTicket}. */
  my: number;
  /** Shared ticket counter — compared against `my` before every commit. */
  ticket: { current: number };
  /** The app-lifetime connection — every navigation remounts over it (ADR item 9). */
  conn: AnyConnection;
  /** Lazy route-module table from `.rpxd/routes.gen.ts`. */
  routeModules: Record<string, () => Promise<{ default: AnyRoute }>>;
  /** Commit the new page (route + pathname). The connection is app-lifetime — never closed here. */
  commit: (page: CurrentPage) => void;
  /** Soft-navigate via the router (redirects, §10). */
  softNavigate: (location: string) => void;
  /** Full page load — unmatched routes and failed navigations. */
  hardLoad: (url: string) => void;
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
 * Run one navigation (§7, ADR 0002 item 9). The two tier branches collapse:
 * **every** pathname change remounts the new page instance over the same
 * app-lifetime connection (tier 3 = tier 2 + a component swap), refreshing the
 * primary store's rpc meta for the arriving route, waits for its snapshot, then
 * commits — unless a newer navigation claimed the ticket meanwhile. Unmatched
 * paths and non-redirect failures fall back to a hard load so the server's
 * 404/error pages stay authoritative.
 *
 * @example
 * ```ts
 * void performNavigation({ pathname, search, my, ticket, conn, routeModules, ...io });
 * ```
 */
export async function performNavigation(io: NavigationIo): Promise<void> {
  // Wouter's location is pathname-only, so hard-load fallbacks rebuild the
  // full target URL from the parsed search — a bare pathname would drop it.
  const query = new URLSearchParams(io.search).toString();
  const target = query ? `${io.pathname}?${query}` : io.pathname;
  const match = matchRoute(Object.keys(io.routeModules), io.pathname);
  const load = match && io.routeModules[match.path];
  if (!load || !match) {
    io.hardLoad(target); // server renders __404
    return;
  }
  try {
    const mod = await load();
    // One path for every tier (ADR item 9): remount the new page instance over
    // the existing stream, swapping the primary store to the arriving route's
    // rpc meta. `remount`'s own run tag self-releases a superseded instance; the
    // navigation ticket below gates the React commit.
    const conn = io.conn;
    await conn.remount(io.pathname, io.search, rpcMetaFromDef(mod.default.def));
    await stateReady(conn);
    if (io.ticket.current !== io.my) return; // superseded — the winner commits
    io.commit({ pathname: io.pathname, route: mod.default, conn });
  } catch (e) {
    // `remount` threw redirect() (§10) — soft-navigate to the target instead of
    // hard-loading the original path.
    if (isRedirect(e)) {
      if (io.ticket.current === io.my) io.softNavigate(e.location);
      return;
    }
    console.error("[rpxd] soft navigation failed, falling back to full load:", e);
    // A stale failure must not clobber a newer navigation with a hard load.
    if (io.ticket.current !== io.my) return;
    io.hardLoad(target);
  }
}
