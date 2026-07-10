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
  LiveInstance,
  type LiveRoute,
  memory,
  type PathParams,
  PROTOCOL_VERSION,
  type RpcBatch,
  type SearchParams,
  type StorageAdapter,
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
export interface TestLiveOptions<Path extends string, Session> {
  /** Typed path params for the route literal (§7). Defaults to `{}`. */
  params?: PathParams<Path>;
  /** Session slice the instance mounts with. Defaults to `{}`. */
  session?: Session;
  /**
   * Search params the mount's `guard` + `load` run with (§7) — the query
   * string of the initial page load. Defaults to `{}`. Use `t.navigate()`
   * for subsequent URL changes.
   */
  search?: SearchParams;
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
export interface TestLive<S, Session, Rpc> {
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
   * Reconcile the instance to a new URL (§7), exactly as a `nav.patch` /
   * page load does: run `guard` (throws `redirect` on a deny) then `load`,
   * awaiting the stream to settle. Assert on `state`/`envelopes` afterwards.
   */
  navigate(search: SearchParams): Promise<void>;
  /**
   * Resolve once everything in flight has landed: pending rpcs (including
   * their streaming flushes), scheduled patch flushes, and the mutation
   * queue. Await this before asserting on streamed or broadcast state.
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
 * and `opts.search`) → `setup` → `load` — and awaits the initial load, so
 * state is loader-populated when the promise resolves. A guard deny or loader
 * redirect rejects with the `RedirectError` the server would map to a 302.
 *
 * @example
 * ```ts
 * import { testLive } from "@rpxd/testing";
 * import route from "../routes/index.tsx";
 *
 * const t = await testLive(route, { search: { filter: "done" } });
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
export async function testLive<S, Path extends string, Session, Component>(
  route: LiveRoute<S, Path, Session, Component>,
  opts: TestLiveOptions<Path, Session> = {},
): Promise<TestLive<S, Session, TestRpcFacade<Component>>> {
  const id = opts.id ?? `test-${++instanceCounter}`;
  const storage = opts.storage ?? memory();
  const params = opts.params ?? ({} as PathParams<Path>);
  const session = opts.session ?? ({} as Session);
  const search = opts.search ?? {};

  // Mount runs the same ordered lifecycle stages as the server's fresh mount
  // (`buildInstance`, §12): guard → setup → load. Guard runs first — before
  // the instance exists — so a denied mount allocates nothing; a deny
  // (`throw redirect`) rejects this call, as the server maps it to a 302.
  if (route.def.guard) {
    await route.def.guard(
      { params, search },
      { params, session, signal: new AbortController().signal },
    );
  }

  const instance = await LiveInstance.create({
    id,
    def: route.def,
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
      await instance.load(search);
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

  const t: TestLive<S, Session, TestRpcFacade<Component>> = {
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
    async navigate(search) {
      try {
        await instance.authorize(search);
      } catch (e) {
        // A concurrent navigate superseded this guard run: the winning
        // navigate owns the outcome — skip the stale URL's load quietly.
        if (isSuperseded(e)) return;
        throw e;
      }
      await instance.load(search);
    },
    async settled() {
      while (inflight.size > 0) {
        await Promise.all([...inflight]);
      }
      // Let any scheduled same-tick patch flush timers fire, then drain.
      await new Promise<void>((r) => setTimeout(r, 0));
      await instance.idle();
      if (inflight.size > 0) return this.settled();
    },
    dispose: () => instance.dispose(),
  };
  return t;
}
