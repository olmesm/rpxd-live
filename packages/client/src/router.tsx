/**
 * Routing surface (§7): typed `Link` and `nav` — wouter under the hood,
 * unexported. Path params are identity (navigate = remount); search params
 * are view state (`nav.patch` → `params` reducer, no remount).
 */
import type { PathParams } from "@rpxd/core";
import { createContext, type ReactNode, useContext } from "react";
import { useLocation, Link as WouterLink } from "wouter";
import type { LiveConnection } from "./connection.ts";

/**
 * Route registration merge point (§7): `.rpxd/routes.gen.ts` augments this
 * with `{ routes: typeof routeTree }`, making `Link`/`nav.navigate` typed
 * for every route in the app.
 */
// biome-ignore lint/suspicious/noEmptyInterface: interface-merge target for generated code
export interface Register {}

type Routes = Register extends { routes: infer R } ? R : Record<string, never>;

/** All registered route paths — falls back to `string` before codegen runs. */
export type RegisteredPath = [keyof Routes] extends [never] ? string : keyof Routes & string;

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

/** Provides the active connection to `useNav()` (installed by the app shell). */
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
  return (
    <WouterLink
      href={buildHref(to, params as Record<string, string> | undefined, search)}
      {...rest}
    />
  );
}

/** The `nav` render prop (§1, §7). */
export interface Nav {
  /** Path params are identity: navigating remounts the live object. */
  navigate<P extends RegisteredPath>(
    to: P,
    opts?: { params?: PathParams<P>; search?: Record<string, string> },
  ): void;
  /**
   * Search params are view state: updates the URL query in place and runs
   * the `params` reducer server-side — no remount.
   */
  patch(search: Record<string, string>): void;
}

/** Hook form of `nav` — the shell passes its result into the render props. */
export function useNav(): Nav {
  const [, setLocation] = useLocation();
  const connection = useContext(ConnectionContext);
  return {
    navigate: (to, opts) =>
      setLocation(buildHref(to, opts?.params as Record<string, string> | undefined, opts?.search)),
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
