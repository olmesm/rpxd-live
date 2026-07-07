/**
 * rpxd client runtime: optimistic replay over confirmed state, transport
 * batching, id linking, and `keyOf` (§4, §6).
 *
 * React bindings live in `@rpxd/client/react`.
 *
 * @packageDocumentation
 */

export type { RenderProps } from "@rpxd/core";
export {
  type Bootstrap,
  type ConnectionOptions,
  type EventSourceLike,
  LiveConnection,
  type WebSocketLike,
} from "./connection.ts";
export { findTempIdLocations, matchIdMap, type TempIdLocation } from "./id-map.ts";
export {
  buildHref,
  Link,
  type Nav,
  type Register,
  type RegisteredPath,
  RpxdProvider,
  useNav,
} from "./router.tsx";
export {
  type ConnectionStatus,
  LiveStore,
  type LiveStoreOptions,
  type RpcMeta,
  rpcMetaFromDef,
  type StoreSnapshot,
  type SyncState,
} from "./store.ts";
