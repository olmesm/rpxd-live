/**
 * rpxd core runtime.
 *
 * Hosts the live-object runtime: the per-instance FIFO queue, Immer patch
 * production, the wire protocol types, the storage adapter seam, and pubsub.
 *
 * @packageDocumentation
 */
export {
  type CreateInstanceOptions,
  DEFAULT_MAX_BATCH_CALLS,
  LiveInstance,
  SESSION_PREFIX,
} from "./instance.ts";
export {
  type BroadcastOptions,
  type EventHandler,
  type Guard,
  type GuardCtx,
  type Handler,
  type HandlerCtx,
  isLongForm,
  type LiveDefinition,
  type LiveRoute,
  type Loader,
  live,
  type Mutator,
  type PathParams,
  type RpcChain,
  type RpcChainBuilt,
  type RpcChainWithInput,
  type RpcCtx,
  type RpcDef,
  type RpcLongForm,
  type SearchParams,
  type SetupCtx,
  type Url,
} from "./live.ts";
export { matchHttpPath, matchHttpRoute, matchPath, matchRoute, type RouteMatch } from "./match.ts";
export { isRedirect, RedirectError, redirect } from "./redirect.ts";
export {
  isRoute,
  type RouteCtx,
  type RouteDefinition,
  type RouteHandlerFn,
  type RouteMethod,
  type RouteObject,
  route,
} from "./route.ts";
export { isSuperseded, SupersededError } from "./supersede.ts";

/**
 * Route registration merge point (§7): `.rpxd/routes.gen.ts` augments this
 * with `{ routes: typeof routeTree }`, typing `Link`, `useNav`, and the
 * `nav` render prop for every route in the app. Declared here (not
 * re-exported) because module augmentation only merges with declarations
 * in the augmented module itself.
 *
 * @example
 * ```ts
 * declare module "@rpxd/core" {
 *   interface Register {
 *     routes: typeof routeTree;
 *   }
 * }
 * ```
 */
// biome-ignore lint/suspicious/noEmptyInterface: interface-merge target for generated code
export interface Register {}
export {
  type Envelope,
  type EnvelopeError,
  type Patch,
  PROTOCOL_VERSION,
  type RpcBatch,
  type RpcCall,
} from "./protocol.ts";
export { SerialQueue } from "./queue.ts";
export { type RateLimit, RateLimitError, TokenBucket } from "./rate-limit.ts";
export type { RegisteredPath } from "./register.ts";
export type {
  ConnectionStatus,
  NavProp,
  Pretty,
  RenderProps,
  RpcFacade,
  SyncState,
} from "./render-props.ts";
export {
  type InferOutput,
  type StandardSchemaResult,
  type StandardSchemaV1,
  ValidationError,
  validateInput,
} from "./standard-schema.ts";
export {
  type BroadcastMessage,
  LocalBus,
  memory,
  type PubSubBus,
  type Snapshot,
  type StorageAdapter,
} from "./storage.ts";
