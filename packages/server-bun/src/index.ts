/**
 * rpxd Bun server: the `ServerAdapter` seam, the HTTP runtime handler
 * (SSE stream, rpc/control endpoints, SSR attach), and route matching.
 *
 * @packageDocumentation
 */
export { bunAdapter, type ServeHandle, type ServeOptions, type ServerAdapter } from "./adapter.ts";
export {
  createRpxdHandler,
  encodeSse,
  type RenderContext,
  type RouteRegistration,
  type RpxdHandlerOptions,
} from "./handler.ts";
export { matchPath, matchRoute, type RouteMatch } from "./match.ts";
