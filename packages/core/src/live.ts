/**
 * `live()` — the core model (§1). One live object per page; reducers run
 * server-side and mutate Immer drafts; the client is plain React fed via
 * props.
 */
import type { Draft } from "immer";
import type { RateLimit } from "./rate-limit.ts";
import type { StandardSchemaV1 } from "./standard-schema.ts";

/** Search params are untyped view state in v1 (§7). */
export type SearchParams = Record<string, string | undefined>;

type Segments<P extends string> = P extends `${infer Head}/${infer Rest}`
  ? Head | Segments<Rest>
  : P;
type ParamName<S extends string> = S extends `$${infer N}` ? N : never;

/**
 * Path params extracted from a route path literal.
 *
 * @example
 * ```ts
 * type P = PathParams<"/org/$orgId/board">; // { orgId: string }
 * ```
 */
export type PathParams<P extends string> = { [K in ParamName<Segments<P>>]: string };

/** Options for {@link RpcCtx.broadcast}. Exclude-self is the default (§8). */
export interface BroadcastOptions {
  /** Deliver the event to the broadcasting instance too (single-code-path pattern). */
  self?: boolean;
}

/** Context available to `mount` (§1, §10). */
export interface MountCtx<Session> {
  /** Authenticated session data (config `session.authenticate`). */
  session: Session;
  /** Subscribe this instance to a pubsub topic; `on:` handlers receive its events. */
  subscribe(topic: string): void;
}

/** Context available to every rpc reducer and `on:` handler. */
export interface RpcCtx<Params, Session> {
  /** Typed path params from the route literal (§7). */
  params: Params;
  /** Authenticated session data — read it, don't mutate it here (§10). */
  session: Session;
  /**
   * Publish an event to a topic (§8). Excludes the sender unless
   * `{ self: true }`.
   */
  broadcast(topic: string, event: string, payload: unknown, opts?: BroadcastOptions): void;
  /**
   * Escape hatch for optimistic id linking (§4): explicitly map a client
   * tempId to the real id when position matching can't infer it. The mapping
   * rides the ack envelope's `idMap`.
   */
  resolveId(tempId: string, realId: string): void;
}

/**
 * Plain reducer: receives the whole-rpc draft, runs atomically, blocks the
 * instance queue for its duration (§3).
 */
export type PlainReducer<S, Payload, Params, Session> = (
  state: Draft<S>,
  payload: Payload,
  ctx: RpcCtx<Params, Session>,
) => void | Promise<void>;

/**
 * Generator reducer: receives `getState` instead of `state` — a fresh draft
 * per segment, one flush per `yield`, queue released at every yield (§3).
 * Never hold a `getState()` result across `yield`/`await` boundaries.
 */
export type GeneratorReducer<S, Payload, Params, Session> = (
  getState: () => Draft<S>,
  payload: Payload,
  ctx: RpcCtx<Params, Session>,
) => AsyncGenerator<void, void, void>;

/** Either reducer form — signature signals semantics (§3). */
export type RpcHandler<S, Payload, Params, Session> =
  | PlainReducer<S, Payload, Params, Session>
  | GeneratorReducer<S, Payload, Params, Session>;

/**
 * Rpc long form (§5): validation, optimism, and recovery in one declaration.
 * The short form (a bare reducer function) stays valid.
 *
 * @example
 * ```ts
 * importCsv: {
 *   input: z.object({ url: z.string().url() }),
 *   async *handler(getState, { url }, ctx) { ... },
 *   onError(state) { state.importing = false; },
 * }
 * ```
 */
export interface RpcLongForm<S, Payload, Params, Session> {
  /** Standard Schema — validated client-side (pre-optimistic) AND server-side. */
  input?: StandardSchemaV1<unknown, Payload>;
  /**
   * Client-side optimistic fn (§4): sync, pure, identity-based lookups only.
   * Runs on the client; never on the server.
   */
  optimistic?: (state: S, payload: Payload, ctx: { tempId(): string }) => void;
  handler: RpcHandler<S, Payload, Params, Session>;
  /**
   * Runs as a queued reducer when `handler` throws — patches push normally.
   * Repairs *state*, not the database (§5).
   */
  onError?: (
    state: Draft<S>,
    error: unknown,
    payload: Payload,
    ctx: RpcCtx<Params, Session>,
  ) => void | Promise<void>;
  /** Per-session token bucket override for this rpc (§10). */
  rateLimit?: RateLimit;
}

/** One rpc declaration: short-form reducer or long form (§5). */
export type RpcDef<S, Params, Session> =
  // biome-ignore lint/suspicious/noExplicitAny: payload type flows from the caller/long form
  RpcHandler<S, any, Params, Session> | RpcLongForm<S, any, Params, Session>;

/** Broadcast event handler (§8): mutates state in response to a topic event. */
export type EventHandler<S, Params, Session> = (
  state: Draft<S>,
  // biome-ignore lint/suspicious/noExplicitAny: event payloads are producer-defined
  payload: any,
  ctx: RpcCtx<Params, Session>,
) => void | Promise<void>;

/**
 * A live object definition (§1).
 */
export interface LiveDefinition<S, Path extends string, Session> {
  /** Runs once per page load (SSR included, §12). Returns initial state. May reject → error route. */
  mount: (params: PathParams<Path>, ctx: MountCtx<Session>) => S | Promise<S>;
  /** Search-param reducer (§7): mutates the session slice, no remount. */
  params?: (session: Draft<Session>, search: SearchParams) => void;
  rpc?: Record<string, RpcDef<S, PathParams<Path>, Session>>;
  on?: Record<string, EventHandler<S, PathParams<Path>, Session>>;
  /** Snapshot version tag (§9): mismatch → discard snapshot, re-mount. */
  version?: string;
}

/** The object `live(path)(def)(component)` evaluates to — consumed by the router. */
export interface LiveRoute<S, Path extends string, Session, Component> {
  readonly $live: true;
  readonly path: Path;
  readonly def: LiveDefinition<S, Path, Session>;
  readonly component: Component;
}

/**
 * Declare a live object for a route (§1).
 *
 * The path literal is scaffolded and maintained by the dev watcher — the
 * filename is truth, the literal is its typed mirror (§7).
 *
 * @example
 * ```tsx
 * export default live("/org/$orgId/board")({
 *   mount: async ({ orgId }, ctx) => {
 *     ctx.subscribe(`org:${orgId}`);
 *     return { projects: await db.project.findMany({ where: { orgId } }) };
 *   },
 *   rpc: {
 *     async create(state, { name }, ctx) {
 *       const p = await db.project.create({ data: { name } });
 *       state.projects.push(p);
 *       ctx.broadcast(`org:${ctx.params.orgId}`, "project.created", p);
 *     },
 *   },
 *   on: { "project.created": (state, p) => { state.projects.push(p); } },
 * })(({ state, rpc, keyOf }) => <Board projects={state.projects} />);
 * ```
 */
export function live<Path extends string>(path: Path) {
  return <S, Session = Record<string, unknown>>(def: LiveDefinition<S, Path, Session>) =>
    <Component>(component: Component): LiveRoute<S, Path, Session, Component> => ({
      $live: true,
      path,
      def,
      component,
    });
}

/** True when an rpc definition uses the long form (§5). */
export function isLongForm<S, P, Sess>(
  def: RpcDef<S, P, Sess>,
): def is RpcLongForm<S, unknown, P, Sess> {
  return typeof def === "object" && def !== null && "handler" in def;
}

/** True when a reducer is a generator function (signature signals semantics, §3). */
export function isGeneratorReducer(fn: unknown): boolean {
  const name = (fn as { constructor?: { name?: string } })?.constructor?.name;
  return name === "AsyncGeneratorFunction" || name === "GeneratorFunction";
}
