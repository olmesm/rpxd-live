/**
 * `@rpxd/testing` — unit-test harness for live objects (§17).
 *
 * Wraps a real {@link LiveInstance} (real queue, real patches, real pubsub —
 * nothing mocked) behind a typed facade: `t.rpc.*` carries the route's exact
 * rpc record, `t.state` is server truth, `t.envelopes` is the wire.
 *
 * @packageDocumentation
 */
import {
  type Envelope,
  isSuperseded,
  type LiveDefinition,
  LiveInstance,
  type LiveRoute,
  memory,
  type PathParams,
  PROTOCOL_VERSION,
  type PropsRecord,
  type RpcBatch,
  type StorageAdapter,
  validateInput,
} from "@rpxd/core";

/**
 * The typed rpc facade of a route's bound component: same keys, same
 * payloads the client `rpc.*` prop has. Falls back to an open record for
 * routes whose component ignores its props.
 */
export type TestRpcFacade<Component> = Component extends (props: infer P) => unknown
  ? P extends { rpc: infer F }
    ? F
    : Record<string, (payload?: unknown) => Promise<void>>
  : Record<string, (payload?: unknown) => Promise<void>>;

/** Options for {@link testLive}. */
export interface TestLiveOptions<Path extends string, Session, Props = PropsRecord> {
  /** Typed path params for the route literal (§7). Defaults to `{}`. */
  params?: PathParams<Path>;
  /** Session slice the instance mounts with. Defaults to `{}`. */
  session?: Session;
  /**
   * Props the mount's `guard` + `load` run with — a page's URL query is its
   * props record, and a prop-addressed object's are its mount props (ADR 0002).
   * When the object declared a props schema, this is **typed and validated**
   * against it (a wrong shape is a compile error, and an invalid value rejects
   * the mount — parity with a server mount's 422); a schema-less object keeps
   * the raw {@link PropsRecord}. Defaults to `{}`. Use {@link TestLive.navigate}
   * or {@link TestLive.patchProps} for subsequent changes.
   */
  props?: Props;
  /**
   * Storage adapter — defaults to a fresh `memory()`. Share one adapter
   * between two `testLive` handles to test multiplayer over the pubsub bus.
   */
  storage?: StorageAdapter;
  /** Instance id (also the pubsub subscriber id, §8). Defaults to a unique id. */
  id?: string;
}

/**
 * A mounted live object under test — see {@link testLive}.
 */
export interface TestLive<S, Session, Rpc, Props = PropsRecord> {
  /** The real underlying instance, for anything the facade doesn't cover. */
  readonly instance: LiveInstance<S, string, Session>;
  /** Current server-confirmed state (live getter). */
  readonly state: S;
  /** Current session slice (live getter). */
  readonly session: Session;
  /**
   * Every envelope emitted after mount, in order — patch chunks, acks,
   * fulls. The wire, as a client connection would see it.
   */
  readonly envelopes: Envelope[];
  /**
   * Typed rpc facade (§5): exact keys and payloads from the route's chain.
   * Calls made in the same tick coalesce into one `RpcBatch` → one ack,
   * exactly like the real client (§6) — each call's promise still resolves
   * independently, but a batch-level error rejects every call in it. The
   * promise resolves on ack and rejects with the ack error when the handler
   * throws or validation fails.
   */
  readonly rpc: Rpc;
  /** Untyped rpc escape hatch — same semantics as `rpc.*`. */
  call(rpc: string, payload?: unknown): Promise<void>;
  /**
   * Inject a broadcast as if a *peer* instance published it (§8): delivered
   * through the storage bus with a foreign sender id, so exclude-self
   * semantics behave exactly as in production.
   */
  broadcast(topic: string, event: string, payload: unknown): void;
  /**
   * Reconcile the instance to a new URL (§7) — the URL-flavored patch, for
   * pages. Exactly as a `nav.patch` / page load does: when the route declared a
   * props schema, **validate** the record first (a reject surfaces here, before
   * anything reconciles — parity with the server's 422); then run `guard`
   * (throws `redirect` on a deny) and `load`, awaiting the stream to settle.
   * Assert on `state`/`envelopes` afterwards.
   *
   * This is the same reconcile as {@link TestLive.patchProps} under the fold —
   * a page's URL query *is* its props record (ADR 0002). Pick the name that
   * reads for the object: `navigate` for URL-addressed pages, `patchProps` for
   * prop-addressed objects.
   *
   * @example
   * ```ts
   * await t.navigate({ filter: "done" });
   * expect(t.state.filter).toBe("done");
   * ```
   */
  navigate(props: Props): Promise<void>;
  /**
   * Patch the instance's props record (ADR 0002) — the props-flavored reconcile,
   * for prop-addressed live objects (the same seam as {@link TestLive.navigate},
   * URL vocabulary aside). When the object declared a props schema, the record is
   * **validated first**: an invalid value rejects the returned promise *before*
   * `guard` or `load` runs (parity with the server mount/patch surface). Then the
   * mount's `guard` reruns (authorization freshness is never weakened) and `load`
   * reruns with the new props — identity (path params) is unchanged, so `setup`
   * does not rerun and state is preserved across the patch (keepPreviousData: a
   * field an earlier rpc wrote survives). `await t.settled()` to flush streamed
   * work, then assert on `state`/`envelopes`.
   *
   * @example
   * ```ts
   * const t = await testLive(widget, { params: { id: "1" }, props: { variant: "compact" } });
   * await t.rpc.pin({ id: "abc" });          // writes state the loader won't touch
   * await t.patchProps({ variant: "full" }); // reruns guard+load, keeps prior state
   * await t.settled();
   * expect(t.state.variant).toBe("full");
   * ```
   */
  patchProps(next: Props): Promise<void>;
  /**
   * Resolve once everything in flight has landed: pending rpcs (including
   * their streaming flushes), scheduled patch flushes, the mutation queue,
   * and the storage bus's in-flight LOCAL deliveries (via `bus.drain()`, so a
   * broadcast fired during settling — or an async bus whose delivery lands out
   * of band — is awaited). Await this before asserting on streamed or broadcast
   * state. The bus guarantee is this-process only; true cross-node fan-out is
   * not modelled by the single-process harness.
   */
  settled(): Promise<void>;
  /** Tear the instance down (aborts in-flight `ctx.signal`s, §3). */
  dispose(): Promise<void>;
}

let instanceCounter = 0;
let rpcCounter = 0;

/** One queued `t.rpc.*`/`t.call` invocation awaiting its tick's coalesced flush. */
interface QueuedCall {
  rpc: string;
  payload: unknown;
  resolve: () => void;
  reject: (e: unknown) => void;
}

/**
 * Mount a route for testing (§17): real runtime, typed access. The mount runs
 * the production lifecycle stages in order — `guard` (against `opts.session`
 * and `opts.props`) → `setup` → `load` — and awaits the initial load, so
 * state is loader-populated when the promise resolves. A guard deny or loader
 * redirect rejects with the `RedirectError` the server would map to a 302.
 *
 * @example
 * ```ts
 * import { testLive } from "@rpxd/testing";
 * import route from "../routes/index.tsx";
 *
 * const t = await testLive(route, { props: { filter: "done" } });
 * expect(t.state.filter).toBe("done");        // the loader already ran
 * await t.rpc.add({ text: "milk" });          // typed payload, resolves on ack
 * expect(t.state.todos).toHaveLength(1);
 *
 * t.broadcast("room:1", "user.joined", { name: "ada" });
 * await t.settled();                          // streams, flushes, queue drained
 * expect(t.envelopes.at(-1)?.patches).toBeDefined();
 * await t.dispose();
 *
 * // a deny-all guard rejects the mount, like the server's 302
 * await expect(testLive(adminRoute)).rejects.toMatchObject({ location: "/login" });
 * ```
 */
export async function testLive<S, Path extends string, Session, Component, Props = PropsRecord>(
  route: LiveRoute<S, Path, Session, Component, Props>,
  // `Props` is inferred from the route alone (NoInfer): `opts.props` is
  // *checked* against the schema output, never a second inference source — so a
  // route's declared props type wins and a wrong-shaped literal is an error.
  opts: TestLiveOptions<Path, Session, NoInfer<Props>> = {},
): Promise<TestLive<S, Session, TestRpcFacade<Component>, Props>> {
  const id = opts.id ?? `test-${++instanceCounter}`;
  const storage = opts.storage ?? memory();
  const params = opts.params ?? ({} as PathParams<Path>);
  const session = opts.session ?? ({} as Session);

  // Validate the initial props against the declared schema (ADR 0002 item 6):
  // the mounter validates props *before* `guard` (untrusted), and an invalid
  // value rejects the mount the way a server mount answers 422 — nothing is
  // allocated. A schema-less object passes the raw record through unchanged.
  const props: Record<string, unknown> = route.props
    ? ((await validateInput(route.props, opts.props ?? {}, `props ${route.path}`)) as Record<
        string,
        unknown
      >)
    : ((opts.props ?? {}) as Record<string, unknown>);

  // Mount runs the same ordered lifecycle stages as the server's fresh mount
  // (`buildInstance`, §12): guard → setup → load. Guard runs first — before
  // the instance exists — so a denied mount allocates nothing; a deny
  // (`throw redirect`) rejects this call, as the server maps it to a 302.
  if (route.def.guard) {
    await route.def.guard(
      // `props` is the schema output (or the raw record with no schema); the
      // runtime record already matches the guard's declared `Props`.
      { params, props: props as Props },
      { params, session, signal: new AbortController().signal },
    );
  }

  const instance = await LiveInstance.create({
    id,
    // The instance is props-type-agnostic (validation is the mounter's job,
    // done above) — erase the `Props` generic to the record it carries at runtime.
    def: route.def as LiveDefinition<S, Path, Session>,
    params,
    session,
    storage,
    storageKey: `test:${route.path}:${id}`,
  });

  const envelopes: Envelope[] = [];
  instance.addListener((env) => envelopes.push(env));

  if (route.def.load) {
    try {
      // Await the *whole* initial run (the server awaits only the first
      // patch) so state is loader-populated and `settled()` is deterministic
      // from the moment `testLive` resolves.
      await instance.load(props);
    } catch (e) {
      // Loader bailed out (a redirect, §10): tear down so the subscriptions
      // `setup` wired don't leak — mirrors the server's half-built disposal.
      await instance.dispose(false);
      throw e;
    }
  }

  const inflight = new Set<Promise<unknown>>();

  // Same-tick coalescing (§6): the real client (LiveStore#call) queues calls
  // and defers the actual send to a `queueMicrotask` flush, so two `rpc.*`
  // calls issued back-to-back land in one `RpcBatch` → one `handleBatch` → one
  // ack. Mirror that boundary exactly here so a harness-green test predicts
  // the client; dispatching each call as its own batch (the old behavior)
  // would pass a test that then fails against a real connection.
  let queue: QueuedCall[] = [];
  let flushScheduled = false;

  const scheduleFlush = (): void => {
    if (flushScheduled) return;
    flushScheduled = true;
    queueMicrotask(() => {
      flushScheduled = false;
      void flush();
    });
  };

  const flush = async (): Promise<void> => {
    if (queue.length === 0) return;
    const calls = queue;
    queue = [];
    const rpcId = `t-${++rpcCounter}`;
    const batch: RpcBatch = {
      v: PROTOCOL_VERSION,
      instance: id,
      rpcId,
      calls: calls.map((c) => ({ rpc: c.rpc, payload: c.payload })),
    };
    await instance.handleBatch(batch);
    for (let i = envelopes.length - 1; i >= 0; i--) {
      const env = envelopes[i];
      if (env?.rpcId !== rpcId) continue;
      if (env.error) {
        // One ack, one error → every call in the batch rejects (the client's
        // #settleOp rejects every op.calls entry from the single ack, §6).
        const e = new Error(env.error.message);
        e.name = env.error.name;
        for (const c of calls) c.reject(e);
        return;
      }
      for (const c of calls) c.resolve();
      return;
    }
    for (const c of calls) c.resolve();
  };

  const call = (rpc: string, payload: unknown = {}): Promise<void> => {
    const run = new Promise<void>((resolve, reject) => {
      queue.push({ rpc, payload, resolve, reject });
      scheduleFlush();
    });
    // Track a rejection-safe copy so settled() never trips on an rpc the
    // test is about to assert rejects.
    const tracked = run.catch(() => {});
    inflight.add(tracked);
    void tracked.finally(() => inflight.delete(tracked));
    return run;
  };

  // The reconcile behind both `navigate` (URL-flavored) and `patchProps`
  // (props-flavored): a page's URL query *is* its props record (ADR 0002), so
  // one seam serves both vocabularies. Validate first when a schema is declared
  // — an invalid value rejects BEFORE `guard`/`load` run, parity with the
  // server's mount/patch 422 — then re-guard (freshness) and re-load (identity
  // unchanged, so `setup` never reruns and prior state is preserved).
  const reconcile = async (next: Props): Promise<void> => {
    const validated: Record<string, unknown> = route.props
      ? ((await validateInput(route.props, next, `props ${route.path}`)) as Record<string, unknown>)
      : (next as Record<string, unknown>);
    try {
      await instance.authorize(validated);
    } catch (e) {
      // A concurrent reconcile superseded this guard run: the winning one owns
      // the outcome — skip the stale URL's load quietly.
      if (isSuperseded(e)) return;
      throw e;
    }
    await instance.load(validated);
  };

  const t: TestLive<S, Session, TestRpcFacade<Component>, Props> = {
    instance: instance as LiveInstance<S, string, Session>,
    get state() {
      return instance.state;
    },
    get session() {
      return instance.session;
    },
    envelopes,
    rpc: new Proxy(
      {},
      {
        get: (_target, name: string) => (payload?: unknown) => call(name, payload ?? {}),
      },
    ) as TestRpcFacade<Component>,
    call,
    broadcast(topic, event, payload) {
      void storage.bus.publish({
        topic,
        event,
        payload,
        senderId: `${id}:peer`,
        self: false,
      });
    },
    navigate: reconcile,
    patchProps: reconcile,
    async settled() {
      while (inflight.size > 0) {
        await Promise.all([...inflight]);
      }
      // Let any scheduled same-tick patch flush timers fire, then drain.
      await new Promise<void>((r) => setTimeout(r, 0));
      await instance.idle();
      // Drain in-flight LOCAL bus deliveries (a broadcast fired during settling,
      // or an async/network bus whose delivery lands out of band), then re-settle
      // the mutation queue those deliveries feed. Scoped to this-process delivery —
      // a single-process harness can't model true cross-node fan-out.
      await storage.bus.drain?.();
      await new Promise<void>((r) => setTimeout(r, 0));
      await instance.idle();
      if (inflight.size > 0) return this.settled();
    },
    dispose: () => instance.dispose(),
  };
  return t;
}
