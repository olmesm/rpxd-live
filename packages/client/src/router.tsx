/**
 * Routing surface (§7): typed `Link` and `nav` — wouter under the hood,
 * unexported. Path params are identity (navigate = soft reload via `setup`);
 * search params are view state (`nav.patch` reruns `guard`+`load`, no `setup`).
 */
import type { NavProp, PathParams, RegisteredPath } from "@rpxd/core";
import { createContext, type MouseEvent, type ReactNode, useContext } from "react";
import { navigate } from "wouter/use-browser-location";
import type { LiveConnection } from "./connection.ts";

// The registration merge point lives in core (§7) so the `nav` render prop
// is typed there too; re-exported here for app-side imports.
export type { Register, RegisteredPath } from "@rpxd/core";

/**
 * Fill a route pattern's `$param` segments from a params record — the shared
 * segment-fill core behind {@link buildHref} and, in ADR 0002, a live object's
 * instance identity (`<LiveSlot>`'s mount key). Values are `encodeURIComponent`'d
 * per segment; a missing param throws. Makes no leading-slash assumption, so it
 * fills both page paths (`/org/$id`) and any pattern a slot addresses.
 *
 * @example
 * ```ts
 * fillPattern("/org/$orgId/board", { orgId: "a/c me" }); // "/org/a%2Fc%20me/board"
 * fillPattern("/chat/$room", { room: "main" });          // "/chat/main"
 * ```
 */
export function fillPattern(pattern: string, params?: Record<string, string>): string {
  return pattern
    .split("/")
    .map((seg) => {
      if (!seg.startsWith("$")) return seg;
      const value = params?.[seg.slice(1)];
      if (value === undefined)
        throw new Error(`Missing path param "${seg.slice(1)}" for ${pattern}`);
      return encodeURIComponent(value);
    })
    .join("/");
}

/**
 * Build a concrete href from a route path literal + params + search.
 *
 * @example
 * ```ts
 * buildHref("/org/$orgId/board", { orgId: "42" }, { filter: "done" });
 * // "/org/42/board?filter=done"
 * ```
 */
export function buildHref(
  to: string,
  params?: Record<string, string>,
  search?: Record<string, string>,
): string {
  const path = fillPattern(to, params);
  const query = search ? new URLSearchParams(search).toString() : "";
  return query ? `${path}?${query}` : path;
}

/**
 * Active-connection context (ADR 0002 item 9): the app shell installs the
 * app-lifetime {@link LiveConnection} here via {@link RpxdProvider}. `useNav`
 * and `<LiveSlot>` read it — the latter to `mountSlot` over the same stream.
 * Internal seam; not part of the public export surface.
 */
export const ConnectionContext = createContext<LiveConnection<
  unknown,
  Record<string, unknown>
> | null>(null);

/**
 * Detect a search-only navigation (§7). Wouter's location is pathname-only,
 * so a navigation that changes just the query string moves the URL bar but
 * never reruns the app shell's effect — `guard`/`load` would silently not
 * rerun. Returns the target's full search record (to reconcile via
 * `patchProps`, tier 1) when `href` points at `currentPathname` with a
 * different query; `null` when the pathname changes (the app shell owns
 * those) or nothing changed at all.
 *
 * @example
 * ```ts
 * const patch = searchOnlyChange("/board?filter=done", "/board", "?filter=all");
 * if (patch) connection.patchProps(patch); // { filter: "done" }
 * ```
 */
export function searchOnlyChange(
  href: string,
  currentPathname: string,
  currentSearch: string,
): Record<string, string> | null {
  const [pathname = href, query = ""] = href.split("?");
  if (pathname !== currentPathname) return null;
  const target = new URLSearchParams(query);
  const current = new URLSearchParams(currentSearch);
  target.sort();
  current.sort();
  if (target.toString() === current.toString()) return null;
  return Object.fromEntries(target) as Record<string, string>;
}

/**
 * Provides the active connection to `useNav()` (installed by the app shell).
 *
 * @example
 * ```tsx
 * <RpxdProvider connection={connection}><App /></RpxdProvider>
 * ```
 */
export function RpxdProvider(props: {
  // biome-ignore lint/suspicious/noExplicitAny: provider accepts any route's connection
  connection: LiveConnection<any, any>;
  children?: ReactNode;
}) {
  return (
    <ConnectionContext.Provider value={props.connection}>
      {props.children}
    </ConnectionContext.Provider>
  );
}

/**
 * Typed link (§7). `to` autocompletes registered paths; `params` fills the
 * `$param` segments.
 *
 * @example
 * ```tsx
 * <Link to="/org/$orgId/board" params={{ orgId }} search={{ filter: "done" }}>Board</Link>
 * ```
 */
export function Link<P extends RegisteredPath>(props: {
  to: P;
  params?: PathParams<P>;
  search?: Record<string, string>;
  children?: ReactNode;
  className?: string;
}) {
  const { to, params, search, ...rest } = props;
  const connection = useContext(ConnectionContext);
  const href = buildHref(to, params as Record<string, string> | undefined, search);
  // Plain anchor (SSR-safe, no router context); soft navigation happens in
  // the click handler, which only ever runs in the browser (§7).
  const onClick = (event: MouseEvent<HTMLAnchorElement>) => {
    const plainLeftClick =
      event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
    if (event.defaultPrevented || !plainLeftClick) return;
    event.preventDefault();
    // A same-path search change is invisible to wouter (pathname-only
    // location): push the history entry, then reconcile guard/load over the
    // live connection (tier 1, §7) since the app shell's effect won't run.
    const patch = searchOnlyChange(href, window.location.pathname, window.location.search);
    navigate(href);
    if (patch) connection?.patchProps(patch);
  };
  return <a href={href} onClick={onClick} {...rest} />;
}

/** The `nav` render prop (§1, §7) — the core {@link NavProp}, typed via `Register`. */
export type Nav = NavProp;

/**
 * Hook form of `nav` — the shell passes its result into the render props.
 *
 * @example
 * ```tsx
 * const nav = useNav();
 * nav.navigate("/org/$orgId/board", { params: { orgId: "acme" } });
 * ```
 */
export function useNav(): Nav {
  const connection = useContext(ConnectionContext);
  return {
    navigate: (to, opts) => {
      const href = buildHref(to, opts?.params as Record<string, string> | undefined, opts?.search);
      // Same dead zone as `Link` (§7): a search-only target never reruns the
      // app shell's effect, so reconcile it over the live connection.
      const patch =
        typeof window !== "undefined"
          ? searchOnlyChange(href, window.location.pathname, window.location.search)
          : null;
      navigate(href);
      if (patch) connection?.patchProps(patch);
    },
    patch: (props) => {
      if (typeof window !== "undefined") {
        const url = new URL(window.location.href);
        for (const [k, v] of Object.entries(props)) url.searchParams.set(k, v);
        window.history.replaceState(null, "", url);
      }
      connection?.patchProps(props);
    },
  };
}
