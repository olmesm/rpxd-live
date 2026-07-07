/**
 * `live()` — the core model (§1). One live object per page; handlers run
 * server-side as plain async fns and write state through `ctx.patchState`;
 * the client is plain React fed via props.
 */
import type { Draft, Immutable } from "immer";
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

/** Context available to every rpc handler and `on:` handler. */
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
 * A synchronous Immer mutator — the only way state changes (§3). Runs against
 * a fresh draft at flush time; the draft never escapes the callback, so the
 * stale-draft bug class is structurally impossible.
 *
 * @example
 * ```ts
 * ctx.patchState((s) => { s.todos.push(todo); });
 * ```
 */
export type Mutator<S> = (state: Draft<S>) => void;

/**
 * Context available to rpc handlers (§3): everything in {@link RpcCtx} plus
 * live state reads, `patchState` writes, and cancellation.
 */
export interface HandlerCtx<S, Params, Session> extends RpcCtx<Params, Session> {
  /**
   * Live read-only view of current state — reads after `await` see writes
   * that landed meanwhile. Writes throw: use {@link HandlerCtx.patchState}.
   */
  readonly state: Immutable<S>;
  /**
   * Queue a sync mutator (§3). Same-tick calls from one rpc coalesce into a
   * single flush; each flush is one atomic patch envelope. Under `.atomic()`
   * all calls buffer until the handler completes.
   */
  patchState(mut: Mutator<S>): void;
  /**
   * Aborted on disconnect/eviction or via {@link HandlerCtx.abort} — pass it
   * to `fetch`/SDK calls so slow work stops with the instance (§3).
   */
  readonly signal: AbortSignal;
  /** Abort in-flight invocations of a named rpc (the stop-generating pattern, §3). */
  abort(rpc: string): void;
}

/**
 * An rpc handler (§3): a plain async fn. Awaits never block the instance —
 * other rpcs, broadcasts, and `params` run freely while it waits.
 */
export type Handler<S, Payload, Params, Session> = (
  payload: Payload,
  ctx: HandlerCtx<S, Params, Session>,
) => void | Promise<void>;

/**
 * Rpc long form (§5): validation, optimism, and recovery in one declaration —
 * the runtime object every fluent chain builds.
 *
 * @example
 * ```ts
 * importCsv: {
 *   input: z.object({ url: z.string().url() }),
 *   async handler({ url }, ctx) {
 *     const rows = await fetchCsv(url);
 *     ctx.patchState((s) => { s.rows = rows; });
 *   },
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
  handler: Handler<S, Payload, Params, Session>;
  /**
   * Sync mutator run as a queued flush when `handler` throws — its patches
   * ride the error ack. Repairs *state*, not the database (§5).
   */
  onError?: (
    state: Draft<S>,
    error: unknown,
    payload: Payload,
    ctx: RpcCtx<Params, Session>,
  ) => void;
  /** Buffer all patchState calls; flush once on success, discard all on throw (§3). */
  atomic?: boolean;
  /** Per-session token bucket override for this rpc (§10). */
  rateLimit?: RateLimit;
}

/** One rpc declaration: bare handler or long form (§5). */
export type RpcDef<S, Params, Session> =
  // biome-ignore lint/suspicious/noExplicitAny: payload type flows from the caller/long form
  Handler<S, any, Params, Session> | RpcLongForm<S, any, Params, Session>;

/** Broadcast event handler (§8): a sync mutator run in response to a topic event. */
export type EventHandler<S, Params, Session> = (
  state: Draft<S>,
  // biome-ignore lint/suspicious/noExplicitAny: event payloads are producer-defined
  payload: any,
  ctx: RpcCtx<Params, Session>,
) => void;

/**
 * The runtime shape a fluent chain builds (§1) — what `LiveInstance` and the
 * server handler consume via `route.def`.
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

/** The object a fluent chain evaluates to — consumed by the router. */
export interface LiveRoute<S, Path extends string, Session, Component> {
  readonly $live: true;
  readonly path: Path;
  readonly def: LiveDefinition<S, Path, Session>;
  readonly component: Component;
}

// ---- fluent builder (§1, §5) ------------------------------------------------

import type { Pretty, RenderProps } from "./render-props.ts";

/** Chain state before a handler is attached: pick `input`/`optimistic`/`atomic`, then the terminal. */
export interface RpcChain<S, Params, Session> {
  /** Standard Schema (§5) — validated client-side (pre-optimistic) AND server-side; locks the payload type. */
  input<In>(schema: StandardSchemaV1<unknown, In>): RpcChainWithInput<S, In, Params, Session>;
  /** Client-side optimistic fn (§4). Locks the payload type from its annotation when no `input` is used. */
  optimistic<In>(
    fn: (state: S, payload: In, ctx: { tempId(): string }) => void,
  ): RpcChainWithInput<S, In, Params, Session>;
  /** Whole-rpc buffered flush + rollback on throw (§3). */
  atomic(): RpcChain<S, Params, Session>;
  /** The single terminal (§3): plain, streaming, and slow work are all just async fns. */
  handler<In = unknown>(fn: Handler<S, In, Params, Session>): RpcChainBuilt<S, In, Params, Session>;
}

/** Chain state with the payload locked to `In`. */
export interface RpcChainWithInput<S, In, Params, Session> {
  optimistic(
    fn: (state: S, payload: In, ctx: { tempId(): string }) => void,
  ): RpcChainWithInput<S, In, Params, Session>;
  atomic(): RpcChainWithInput<S, In, Params, Session>;
  handler(fn: Handler<S, In, Params, Session>): RpcChainBuilt<S, In, Params, Session>;
}

/** Terminal chain state: recovery + limits, and the built long-form def. */
export interface RpcChainBuilt<S, In, Params, Session> {
  /** Sync mutator run as a queued flush on handler throw; patches ride the error ack (§5). */
  onError(
    fn: (state: Draft<S>, error: unknown, payload: In, ctx: RpcCtx<Params, Session>) => void,
  ): RpcChainBuilt<S, In, Params, Session>;
  /** Per-session token bucket override (§10). */
  rateLimit(limit: RateLimit): RpcChainBuilt<S, In, Params, Session>;
  /** The runtime long-form definition this chain built. */
  readonly def: RpcLongForm<S, In, Params, Session>;
}

/**
 * The fluent route builder. State `S` is locked by `.mount()`; each
 * `.rpc(name, ...)` extends the typed rpc record `R`, which `.render()`
 * hands to the component as an exact-keyed, payload-typed `rpc` facade.
 */
export interface LiveBuilder<S, Path extends string, Session, R> {
  /** Declare an rpc (§5): `r.input(schema).optimistic(fn).handler(fn).onError(fn)`. */
  rpc<Name extends string, In>(
    name: Name,
    build: (
      r: RpcChain<S, PathParams<Path>, Session>,
    ) => RpcChainBuilt<S, In, PathParams<Path>, Session>,
  ): LiveBuilder<S, Path, Session, R & Record<Name, In>>;
  /** Broadcast handler (§8): a sync mutator run in response to a topic event. */
  on(
    event: string,
    handler: EventHandler<S, PathParams<Path>, Session>,
  ): LiveBuilder<S, Path, Session, R>;
  /** Search-param reducer (§7): mutates the session slice, no remount. */
  params(
    reducer: (session: Draft<Session>, search: SearchParams) => void,
  ): LiveBuilder<S, Path, Session, R>;
  /** Snapshot version tag (§9): mismatch → discard snapshot, re-mount. */
  version(tag: string): LiveBuilder<S, Path, Session, R>;
  /** Bind the component (§1) — receives fully typed {@link RenderProps}. */
  render<Component extends (props: RenderProps<S, Session, Pretty<R>>) => unknown>(
    component: Component,
  ): LiveRoute<S, Path, Session, Component>;
}

/** First (and only) step after `live(path)`: lock state via `mount`. */
export interface LiveStart<Path extends string> {
  /** Runs once per page load (SSR included, §12). Returns initial state. May reject → error route. */
  mount<S, Session = Record<string, unknown>>(
    fn: (params: PathParams<Path>, ctx: MountCtx<Session>) => S | Promise<S>,
  ): LiveBuilder<Awaited<S>, Path, Session, Record<never, never>>;
}

// biome-ignore lint/suspicious/noExplicitAny: runtime chain is shaped by the public interfaces above
function rpcChain(partial: Record<string, any>): any {
  return {
    input: (schema: unknown) => rpcChain({ ...partial, input: schema }),
    optimistic: (fn: unknown) => rpcChain({ ...partial, optimistic: fn }),
    atomic: () => rpcChain({ ...partial, atomic: true }),
    handler: (fn: unknown) => rpcChain({ ...partial, handler: fn }),
    onError: (fn: unknown) => rpcChain({ ...partial, onError: fn }),
    rateLimit: (limit: unknown) => rpcChain({ ...partial, rateLimit: limit }),
    get def() {
      return partial;
    },
  };
}

// biome-ignore lint/suspicious/noExplicitAny: runtime builder is shaped by LiveBuilder above
function liveBuilder(path: string, def: Record<string, any>): any {
  return {
    rpc: (name: string, build: (r: unknown) => { def: unknown }) =>
      liveBuilder(path, { ...def, rpc: { ...def.rpc, [name]: build(rpcChain({})).def } }),
    on: (event: string, handler: unknown) =>
      liveBuilder(path, { ...def, on: { ...def.on, [event]: handler } }),
    params: (reducer: unknown) => liveBuilder(path, { ...def, params: reducer }),
    version: (tag: string) => liveBuilder(path, { ...def, version: tag }),
    render: (component: unknown) => ({ $live: true, path, def, component }),
  };
}

/**
 * Declare a live object for a route (§1) — fluent: state locks at `.mount()`
 * and every later step infers from it; `.render()` terminates the chain with
 * the same `LiveRoute` object the runtime has always consumed.
 *
 * The path literal is scaffolded and maintained by the dev watcher — the
 * filename is truth, the literal is its typed mirror (§7).
 *
 * @example
 * ```tsx
 * export default live("/org/$orgId/board")
 *   .mount(async ({ orgId }, ctx) => {
 *     ctx.subscribe(`org:${orgId}`);
 *     return { projects: await db.project.findMany({ where: { orgId } }) };
 *   })
 *   .rpc("create", (r) =>
 *     r.input(z.object({ name: z.string() })).handler(async ({ name }, ctx) => {
 *       const p = await db.project.create({ data: { name } });
 *       ctx.patchState((s) => { s.projects.push(p); });
 *       ctx.broadcast(`org:${ctx.params.orgId}`, "project.created", p);
 *     }),
 *   )
 *   .on("project.created", (state, p) => {
 *     state.projects.push(p);
 *   })
 *   .render(({ state, rpc, keyOf }) => <Board projects={state.projects} />);
 * ```
 */
export function live<Path extends string>(path: Path): LiveStart<Path> {
  return {
    mount: (fn) => liveBuilder(path, { mount: fn }),
  } as LiveStart<Path>;
}

/** True when an rpc definition uses the long form (§5). */
export function isLongForm<S, P, Sess>(
  def: RpcDef<S, P, Sess>,
): def is RpcLongForm<S, unknown, P, Sess> {
  return typeof def === "object" && def !== null && "handler" in def;
}
