/**
 * rpxd Bun server: the `ServerAdapter` seam, the HTTP runtime handler
 * (SSE stream, rpc/control endpoints, SSR attach), and route matching.
 *
 * @packageDocumentation
 */
export {
  bunAdapter,
  type ServeHandle,
  type ServeOptions,
  type ServerAdapter,
  type SocketLike,
  type WebSocketHandlers,
} from "./adapter.ts";
export {
  createRpxdHandler,
  encodeSse,
  type HttpRouteRegistration,
  type RenderContext,
  type RouteRegistration,
  type RpxdHandlerOptions,
  type SecurityEvent,
} from "./handler.ts";
export {
  matchHttpPath,
  matchHttpRoute,
  matchPath,
  matchRoute,
  type RouteMatch,
} from "./match.ts";
export { type AllowedOrigins, originAllowed } from "./origin.ts";
export { wsTransport } from "./ws.ts";
