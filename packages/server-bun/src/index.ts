/**
 * rpxd Bun server: the `ServerAdapter` seam, the HTTP runtime handler
 * (SSE stream, rpc/control endpoints, SSR attach), and route matching.
 *
 * @packageDocumentation
 */

// Re-export the unified event-sink API (#73) so adapter/CLI packages that
// already depend on server-bun can report `request`-category events without a
// direct @rpxd/core runtime dependency.
export {
  defaultEventSink,
  makeEmit,
  type RpxdEvent,
  type RpxdEventSink,
} from "@rpxd/core";
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
