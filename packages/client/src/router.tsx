/**
 * Routing surface (§7): typed `Link` and `nav` — wouter under the hood,
 * unexported. Path params are identity (navigate = remount); search params
 * are view state (`nav.patch` → `params` reducer, no remount).
 */
import type { NavProp, PathParams, RegisteredPath } from "@rpxd/core";
import { createContext, type MouseEvent, type ReactNode, useContext } from "react";
import { navigate } from "wouter/use-browser-location";
import type { LiveConnection } from "./connection.ts";

// The registration merge point lives in core (§7) so the `nav` render prop
// is typed there too; re-exported here for app-side imports.
export type { Register, RegisteredPath } from "@rpxd/core";

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
  const path = to
    .split("/")
    .map((seg) => {
      if (!seg.startsWith("$")) return seg;
      const value = params?.[seg.slice(1)];
      if (value === undefined) throw new Error(`Missing path param "${seg.slice(1)}" for ${to}`);
      return encodeURIComponent(value);
    })
    .join("/");
  const query = search ? new URLSearchParams(search).toString() : "";
  return query ? `${path}?${query}` : path;
}

const ConnectionContext = createContext<LiveConnection<unknown, Record<string, unknown>> | null>(
  null,
);

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
  const href = buildHref(to, params as Record<string, string> | undefined, search);
  // Plain anchor (SSR-safe, no router context); soft navigation happens in
  // the click handler, which only ever runs in the browser (§7).
  const onClick = (event: MouseEvent<HTMLAnchorElement>) => {
    const plainLeftClick =
      event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
    if (event.defaultPrevented || !plainLeftClick) return;
    event.preventDefault();
    navigate(href);
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
    navigate: (to, opts) =>
      navigate(buildHref(to, opts?.params as Record<string, string> | undefined, opts?.search)),
    patch: (search) => {
      if (typeof window !== "undefined") {
        const url = new URL(window.location.href);
        for (const [k, v] of Object.entries(search)) url.searchParams.set(k, v);
        window.history.replaceState(null, "", url);
      }
      connection?.patchParams(search);
    },
  };
}
