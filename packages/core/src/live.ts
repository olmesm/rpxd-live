/**
 * `live()` — the core model (§1). One live object per page; handlers run
 * server-side as plain async fns and write state through `ctx.patchState`;
 * the client is plain React fed via props.
 */
import type { Draft, Immutable } from "immer";
import type { RateLimit } from "./rate-limit.ts";
import type { EventName, EventPayload } from "./register.ts";
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

/** Context available to `setup` (§1, §8): path params, session, subscribe. */
export interface SetupCtx<Params, Session> {
  /** Typed path params from the route literal (§7). */
  params: Params;
  /** Authenticated session data (config `session.authenticate`). */
  session: Session;
  /** Subscribe this instance to a pubsub topic; `on:` handlers receive its events. */
  subscribe(topic: string): void;
}

/**
 * The whole URL handed to `load` (§7): typed path params plus untyped search.
 * `params` is the route literal's path params; `search` is the query string.
 */
export interface Url<Params> {
  /** Typed path params from the route literal (`/org/$orgId` → `{ orgId }`). */
  params: Params;
  /** Untyped search/query params — view state in v1 (`?filter=…`). */
  search: SearchParams;
}

/** Context available to every rpc handler and `on:` handler. */
export interface RpcCtx<Params, Session> {
  /** Typed path params from the route literal (§7). */
  params: Params;
  /** Authenticated session data — read it, don't mutate it here (§10). */
  session: Session;
  /**
   * Publish an `event` with `payload` to every instance subscribed to `topic`
   * (§8). Excludes the sending instance unless `{ self: true }`.
   *
   * **Typesafety is opt-in.** Out of the box `event` is any `string` and
   * `payload` is unchecked. To autocomplete event names and type-check payloads,
   * augment the {@link Register} interface with an `events` map — event name →
   * payload shape — in a `.d.ts` covered by your `tsconfig`. There is no
   * codegen: the map is maintained by hand, and unregistered events stay
   * permissive.
   *
   * @example Opt in to typed events — e.g. `rpxd-events.d.ts`
   * ```ts
   * import type { Message } from "./routes/chat.tsx";
   *
   * declare module "@rpxd/core" {
   *   interface Register {
   *     events: {
   *       "message.created": Message;
   *       "typing": { userId: string };
   *     };
   *   }
   * }
   * ```
   *
   * @example Broadcasting — the event autocompletes and the payload is checked
   * ```ts
   * ctx.broadcast("chat:lobby", "message.created", message);
   * ctx.broadcast("chat:lobby", "typing", { userId: ctx.session.id });
   * ```
   */
  broadcast<const K extends EventName>(
    topic: string,
    event: K,
    payload: EventPayload<K>,
    opts?: BroadcastOptions,
  ): void;
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
   * single flush; each flush is one patch envelope. For whole-rpc all-or-nothing,
   * do the fallible work first and `patchState` once at the end (or `.onError` to
   * repair state on throw).
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
 * other rpcs, broadcasts, and `load` run freely while it waits.
 */
export type Handler<S, Payload, Params, Session> = (
  payload: Payload,
  ctx: HandlerCtx<S, Params, Session>,
) => void | Promise<void>;

/**
 * The URL-keyed loader (§7) — the single place URL-dependent data is loaded.
 * A plain async fn keyed to the whole URL: runs once after `setup` and again on
 * every URL change (path or search). The first argument is `{ params, search }`
 * (typed path params + untyped query); writes go through `ctx.patchState` (page
 * state); `ctx.session` is a live read-only view. Loading and errors are
 * ordinary state the loader writes — there is no ack. `throw redirect(...)` to
 * deny (§10).
 *
 * **Latest-wins**: a newer invocation aborts the prior one's `ctx.signal` and
 * discards its late flushes, so rapid filter/page changes resolve to the last
 * URL, not to whichever query returned last. Pass `ctx.signal` to `fetch`/SDK
 * calls so a superseded load stops early.
 *
 * @example
 * ```ts
 * .load(async ({ params, search }, ctx) => {
 *   ctx.patchState((s) => { s.filter = search.filter ?? "all"; s.loading = true; });
 *   const page = await listTodos(scopeFrom(ctx.session), {
 *     filter: search.filter, cursor: search.cursor ?? null, limit: 20, signal: ctx.signal,
 *   });
 *   ctx.patchState((s) => {
 *     s.todos = search.cursor ? [...s.todos, ...page.items] : page.items;
 *     s.cursor = page.nextCursor;
 *     s.hasMore = page.nextCursor != null;
 *     s.loading = false;
 *   });
 * })
 * ```
 */
export type Loader<S, Params, Session> = (
  url: Url<Params>,
  ctx: HandlerCtx<S, Params, Session>,
) => void | Promise<void>;

/** Context available to `guard` (§10): auth reads + cancellation. No state writes. */
export interface GuardCtx<Params, Session> {
  /** Typed path params from the route literal (§7). */
  params: Params;
  /** Authenticated session data — read it to authorize (§10). */
  session: Session;
  /** Aborted when a newer URL supersedes this run — pass to async auth checks. */
  readonly signal: AbortSignal;
}

/**
 * The auth guard (§7, §10) — runs before `load` on **every** URL change (path
 * or search). `throw redirect(...)` to deny. Because it runs on search changes
 * too, a spoofed/edited `?cursor=…`/`?userId=…` is re-checked. It's a gate, not
 * a loader: no `patchState`. Pass `ctx.signal` to async auth lookups.
 *
 * @example
 * ```ts
 * .guard(async ({ params }, ctx) => {
 *   if (!ctx.session.user) throw redirect("/login");
 *   if (!(await canView(ctx.session, params.id))) throw redirect("/403");
 * })
 * ```
 */
export type Guard<Params, Session> = (
  url: Url<Params>,
  ctx: GuardCtx<Params, Session>,
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
  /** Per-session token bucket override for this rpc (§10). */
  rateLimit?: RateLimit;
}

/** One rpc declaration: bare handler or long form (§5). */
export type RpcDef<S, Params, Session> =
  // biome-ignore lint/suspicious/noExplicitAny: payload type flows from the caller/long form
  Handler<S, any, Params, Session> | RpcLongForm<S, any, Params, Session>;

/**
 * Broadcast event handler (§8): a sync mutator run in response to a topic event.
 * `Payload` is the registered shape for the event (see {@link RpcCtx.broadcast}),
 * or `any` for an unregistered event.
 */
export type EventHandler<S, Payload, Params, Session> = (
  state: Draft<S>,
  payload: Payload,
  ctx: RpcCtx<Params, Session>,
) => void;

/**
 * The runtime shape a fluent chain builds (§1) — what `LiveInstance` and the
 * server handler consume via `route.def`.
 */
export interface LiveDefinition<S, Path extends string, Session> {
  /**
   * Runs on identity — a path-param change (SSR included, §12). **Sync**: wires
   * subscriptions and returns the state skeleton (locks type `S`). No IO —
   * URL-dependent data loads in {@link LiveDefinition.load}. May `throw redirect`
   * for a coarse fail-fast (§10).
   */
  setup: (ctx: SetupCtx<PathParams<Path>, Session>) => S;
  /** Auth (§10): runs before `load` on every URL change, `throw redirect` to deny. See {@link Guard}. */
  guard?: Guard<PathParams<Path>, Session>;
  /**
   * URL-keyed loader (§7): runs after `setup`+`guard` and on every URL change,
   * writes page state, latest-wins. See {@link Loader}.
   */
  load?: Loader<S, PathParams<Path>, Session>;
  rpc?: Record<string, RpcDef<S, PathParams<Path>, Session>>;
  // biome-ignore lint/suspicious/noExplicitAny: the runtime record is keyed by arbitrary event name, so payloads are heterogeneous here
  on?: Record<string, EventHandler<S, any, PathParams<Path>, Session>>;
  /** Snapshot version tag (§9): mismatch → discard snapshot, re-setup. */
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

/** Chain state before a handler is attached: pick `input`/`optimistic`, then the terminal. */
export interface RpcChain<S, Params, Session> {
  /** Standard Schema (§5) — validated client-side (pre-optimistic) AND server-side; locks the payload type. */
  input<In>(schema: StandardSchemaV1<unknown, In>): RpcChainWithInput<S, In, Params, Session>;
  /** Client-side optimistic fn (§4). Locks the payload type from its annotation when no `input` is used. */
  optimistic<In>(
    fn: (state: S, payload: In, ctx: { tempId(): string }) => void,
  ): RpcChainWithInput<S, In, Params, Session>;
  /** The single terminal (§3): plain, streaming, and slow work are all just async fns. */
  handler<In = unknown>(fn: Handler<S, In, Params, Session>): RpcChainBuilt<S, In, Params, Session>;
}

/** Chain state with the payload locked to `In`. */
export interface RpcChainWithInput<S, In, Params, Session> {
  optimistic(
    fn: (state: S, payload: In, ctx: { tempId(): string }) => void,
  ): RpcChainWithInput<S, In, Params, Session>;
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
 * The fluent route builder. State `S` is locked by `.setup()`; each
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
  /**
   * Broadcast handler (§8): a sync mutator run in response to a topic event.
   * `payload` is typed from the same `Register["events"]` map that types
   * {@link RpcCtx.broadcast} — see that method to opt into typed events. Until an
   * event is registered its `payload` is `any`.
   *
   * @example
   * ```ts
   * .on("message.created", (state, message) => {
   *   state.messages.push(message); // message: Message, once the event is registered
   * })
   * ```
   */
  on<const K extends EventName>(
    event: K,
    handler: EventHandler<S, EventPayload<K>, PathParams<Path>, Session>,
  ): LiveBuilder<S, Path, Session, R>;
  /**
   * Auth guard (§10): runs before `load` on every URL change; `throw redirect`
   * to deny. First arg is `{ params, search }`; no state writes. See {@link Guard}.
   */
  guard(guard: Guard<PathParams<Path>, Session>): LiveBuilder<S, Path, Session, R>;
  /**
   * URL-keyed loader (§7): runs after `setup`+`guard` and on every URL change,
   * writes page state via `ctx.patchState`, latest-wins. First arg is
   * `{ params, search }`. See {@link Loader}. SSR renders state through the
   * loader's first patch, then streams (§12) — `await` the data before the
   * first `patchState` for a crawlable, data-complete first paint.
   */
  load(loader: Loader<S, PathParams<Path>, Session>): LiveBuilder<S, Path, Session, R>;
  /** Snapshot version tag (§9): mismatch → discard snapshot, re-setup. */
  version(tag: string): LiveBuilder<S, Path, Session, R>;
  /** Bind the component (§1) — receives fully typed {@link RenderProps}. */
  render<Component extends (props: RenderProps<S, Session, Pretty<R>>) => unknown>(
    component: Component,
  ): LiveRoute<S, Path, Session, Component>;
}

/** First (and only) step after `live(path)`: lock state via `setup`. */
export interface LiveStart<Path extends string> {
  /**
   * Wire subscriptions and return the state skeleton (§1). **Sync** — locks
   * type `S` from the return; URL-dependent data loads in `.load()` (§7).
   */
  setup<S, Session = Record<string, unknown>>(
    fn: (ctx: SetupCtx<PathParams<Path>, Session>) => S,
  ): LiveBuilder<S, Path, Session, Record<never, never>>;
}

// biome-ignore lint/suspicious/noExplicitAny: runtime chain is shaped by the public interfaces above
function rpcChain(partial: Record<string, any>): any {
  return {
    input: (schema: unknown) => rpcChain({ ...partial, input: schema }),
    optimistic: (fn: unknown) => rpcChain({ ...partial, optimistic: fn }),
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
    guard: (guard: unknown) => liveBuilder(path, { ...def, guard }),
    load: (loader: unknown) => liveBuilder(path, { ...def, load: loader }),
    version: (tag: string) => liveBuilder(path, { ...def, version: tag }),
    render: (component: unknown) => ({ $live: true, path, def, component }),
  };
}

/**
 * Declare a live object for a route (§1) — fluent: state shape locks at
 * `.setup()` and every later step infers from it; `.render()` terminates the
 * chain with the same `LiveRoute` object the runtime consumes.
 *
 * The path literal is scaffolded and maintained by the dev watcher — the
 * filename is truth, the literal is its typed mirror (§7).
 *
 * @example
 * ```tsx
 * export default live("/org/$orgId/board")
 *   .setup((ctx) => {
 *     ctx.subscribe(`org:${ctx.params.orgId}`);
 *     return { projects: [] as Project[], loading: true };
 *   })
 *   .load(async ({ params }, ctx) => {
 *     const projects = await db.project.findMany({ where: { orgId: params.orgId } });
 *     ctx.patchState((s) => { s.projects = projects; s.loading = false; });
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
    setup: (fn) => liveBuilder(path, { setup: fn }),
  } as LiveStart<Path>;
}

/**
 * True when an rpc definition uses the long form (§5).
 *
 * @example
 * ```ts
 * const optimistic = isLongForm(def) ? def.optimistic : undefined;
 * ```
 */
export function isLongForm<S, P, Sess>(
  def: RpcDef<S, P, Sess>,
): def is RpcLongForm<S, unknown, P, Sess> {
  return typeof def === "object" && def !== null && "handler" in def;
}
