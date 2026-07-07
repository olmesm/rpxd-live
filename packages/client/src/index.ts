/**
 * rpxd client runtime: optimistic replay over confirmed state, transport
 * batching, id linking, and `keyOf` (§4, §6).
 *
 * React bindings live in `@rpxd/client/react`.
 *
 * @packageDocumentation
 */
export { findTempIdLocations, matchIdMap, type TempIdLocation } from "./id-map.ts";
export {
  type ConnectionStatus,
  LiveStore,
  type LiveStoreOptions,
  type RpcMeta,
  rpcMetaFromDef,
  type StoreSnapshot,
  type SyncState,
} from "./store.ts";
