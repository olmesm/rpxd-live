/**
 * HTTP routes (the routes & auth guide): plain request → `Response` handlers
 * that live in `routes/` alongside live pages. Where {@link live} builds a
 * stateful page, `route()` builds a server-only endpoint — webhooks, uploads,
 * or delegating a whole subtree to an auth library.
 *
 * Thin on purpose: a handler gets the request, the path params, and the
 * resolved session — nothing of `live()`'s state/patch machinery. The terminal
 * method is the only thing that varies: `.get`/`.post`/… implement one method;
 * `.all` forwards every method (the delegation case).
 */
import type { PathParams } from "./live.ts";

/** HTTP methods a {@link route} can handle; `ALL` matches any method. */
export type RouteMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS";

/** Context handed to an HTTP route handler. */
export interface RouteCtx<Params> {
  /** Path params from the route literal; a trailing `$` catch-all lands under `$`. */
  params: Params;
  /** Authenticated session (config `authenticate`) — the scope source (§10). */
  session: unknown;
  /** Framework session id — the identity used for instance routing and storage. */
  sid: string;
}

/** A single HTTP route handler. */
export type RouteHandlerFn<Params> = (
  req: Request,
  ctx: RouteCtx<Params>,
) => Response | Promise<Response>;

/** Runtime shape the server dispatches on — method → handler (`ALL` = any). */
export interface RouteDefinition {
  // biome-ignore lint/suspicious/noExplicitAny: handlers hosted for routes of any param shape
  handlers: Partial<Record<RouteMethod | "ALL", RouteHandlerFn<any>>>;
  /**
   * CSRF opt-out (S3) for state-changing methods (`POST`/`PUT`/`PATCH`/`DELETE`).
   * `GET`/`HEAD`/`OPTIONS` are always exempt regardless of this flag — a
   * top-level nav is legitimately cross-site, and `OPTIONS` is a CORS
   * preflight. Set via {@link RouteObject.crossOrigin}; `undefined`/`false`
   * means the adapter enforces same-origin (`originAllowed`) by default.
   */
  crossOrigin?: boolean;
}

/**
 * The object a `route()` chain evaluates to (and is itself). Each method
 * returns the same shape with one more handler attached, so
 * `export default route("/x").get(...).post(...)` works with no terminal call.
 */
export interface RouteObject<Path extends string = string> {
  readonly $route: true;
  readonly path: Path;
  readonly def: RouteDefinition;
  /** Handle `GET`. */
  get(fn: RouteHandlerFn<PathParams<Path>>): RouteObject<Path>;
  /** Handle `POST`. */
  post(fn: RouteHandlerFn<PathParams<Path>>): RouteObject<Path>;
  /** Handle `PUT`. */
  put(fn: RouteHandlerFn<PathParams<Path>>): RouteObject<Path>;
  /** Handle `PATCH`. */
  patch(fn: RouteHandlerFn<PathParams<Path>>): RouteObject<Path>;
  /** Handle `DELETE`. */
  delete(fn: RouteHandlerFn<PathParams<Path>>): RouteObject<Path>;
  /** Handle `HEAD`. */
  head(fn: RouteHandlerFn<PathParams<Path>>): RouteObject<Path>;
  /** Handle `OPTIONS`. */
  options(fn: RouteHandlerFn<PathParams<Path>>): RouteObject<Path>;
  /** Handle every method — forward a whole subtree (the delegation case). */
  all(fn: RouteHandlerFn<PathParams<Path>>): RouteObject<Path>;
  /**
   * Opt this route out of the default same-origin (CSRF) check on its
   * state-changing methods (S3) — for endpoints that are deliberately
   * cross-origin (a public webhook, a delegated auth subtree). `GET`/`HEAD`/
   * `OPTIONS` never needed the check to begin with, so this only changes
   * behavior for `POST`/`PUT`/`PATCH`/`DELETE`. A modifier, not a terminal
   * handler — chainable before or after the method calls, and immutable like
   * them (returns a fresh route; the receiver is untouched).
   *
   * @example
   * ```ts
   * // routes/api.webhooks.stripe.ts → /api/webhooks/stripe
   * // Stripe's own IP/signature is the real auth here, so the app opts this
   * // endpoint out of the same-origin default explicitly.
   * export default route("/api/webhooks/stripe")
   *   .crossOrigin()
   *   .post(async (req, ctx) => {
   *     await handleStripe(req, ctx.session);
   *     return new Response(null, { status: 204 });
   *   });
   * ```
   */
  crossOrigin(): RouteObject<Path>;
}

function makeRoute<Path extends string>(
  path: Path,
  handlers: RouteDefinition["handlers"],
  crossOrigin = false,
): RouteObject<Path> {
  const add = (method: RouteMethod | "ALL", fn: RouteHandlerFn<PathParams<Path>>) =>
    makeRoute(path, { ...handlers, [method]: fn }, crossOrigin);
  return {
    $route: true,
    path,
    def: { handlers, crossOrigin },
    get: (fn) => add("GET", fn),
    post: (fn) => add("POST", fn),
    put: (fn) => add("PUT", fn),
    patch: (fn) => add("PATCH", fn),
    delete: (fn) => add("DELETE", fn),
    head: (fn) => add("HEAD", fn),
    options: (fn) => add("OPTIONS", fn),
    all: (fn) => add("ALL", fn),
    crossOrigin: () => makeRoute(path, handlers, true),
  };
}

/**
 * Declare an HTTP route for a `routes/*.ts` file (the routes & auth guide).
 * The path literal is maintained by the dev watcher from the filename, exactly
 * like {@link live} (§7); a trailing `$` segment is a catch-all.
 *
 * @example
 * ```ts
 * // routes/api.webhooks.stripe.ts → /api/webhooks/stripe
 * // Stripe posts here from its own origin, so this state-changing route opts
 * // out of the same-origin default (S3) — Stripe's signature is the real auth.
 * export default route("/api/webhooks/stripe")
 *   .crossOrigin()
 *   .post(async (req, ctx) => {
 *     await handleStripe(req, ctx.session);
 *     return new Response(null, { status: 204 });
 *   });
 *
 * // routes/api.auth.$.ts → /api/auth/*  (all methods, delegated)
 * export default route("/api/auth/$").all((req) => auth.handler(req));
 * ```
 */
export function route<Path extends string>(path: Path): RouteObject<Path> {
  return makeRoute(path, {});
}

/**
 * True when a route module's default export is an HTTP {@link route} object
 * (as opposed to a {@link live} page). Used by the runtime to branch.
 *
 * @example
 * ```ts
 * if (isRoute(mod.default)) registerHttp(mod.default);
 * ```
 */
export function isRoute(value: unknown): value is RouteObject {
  return typeof value === "object" && value !== null && "$route" in value;
}
