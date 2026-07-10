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
   * Each call is one batch; the promise resolves on ack and rejects with the
   * ack error when the handler throws or validation fails.
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

/**
 * Mount a route for testing (§17): real runtime, typed access.
 *
 * @example
 * ```ts
 * import { testLive } from "@rpxd/testing";
 * import route from "../routes/index.tsx";
 *
 * const t = await testLive(route);
 * await t.rpc.add({ text: "milk" });          // typed payload, resolves on ack
 * expect(t.state.todos).toHaveLength(1);
 *
 * t.broadcast("room:1", "user.joined", { name: "ada" });
 * await t.settled();                          // streams, flushes, queue drained
 * expect(t.envelopes.at(-1)?.patches).toBeDefined();
 * await t.dispose();
 * ```
 */
export async function testLive<S, Path extends string, Session, Component>(
  route: LiveRoute<S, Path, Session, Component>,
  opts: TestLiveOptions<Path, Session> = {},
): Promise<TestLive<S, Session, TestRpcFacade<Component>>> {
  const id = opts.id ?? `test-${++instanceCounter}`;
  const storage = opts.storage ?? memory();
  const instance = await LiveInstance.create({
    id,
    def: route.def,
    params: opts.params ?? ({} as PathParams<Path>),
    session: opts.session ?? ({} as Session),
    storage,
    storageKey: `test:${route.path}:${id}`,
  });

  const envelopes: Envelope[] = [];
  instance.addListener((env) => envelopes.push(env));

  const inflight = new Set<Promise<unknown>>();

  const call = (rpc: string, payload: unknown = {}): Promise<void> => {
    const rpcId = `t-${++rpcCounter}`;
    const batch: RpcBatch = {
      v: PROTOCOL_VERSION,
      instance: id,
      rpcId,
      calls: [{ rpc, payload }],
    };
    const run = (async () => {
      await instance.handleBatch(batch);
      for (let i = envelopes.length - 1; i >= 0; i--) {
        const env = envelopes[i];
        if (env?.rpcId !== rpcId) continue;
        if (env.error) {
          const e = new Error(env.error.message);
          e.name = env.error.name;
          throw e;
        }
        return;
      }
    })();
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
