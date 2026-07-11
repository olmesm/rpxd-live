import type { BroadcastMessage, LiveDefinition, RpxdEvent } from "@rpxd/core";
import { LiveInstance } from "@rpxd/core";
import { describe, expect, it, vi } from "vitest";
import { type RedisLikeClient, redis } from "../src/index.ts";

/** In-memory fake standing in for a shared redis server. */
function fakeRedisServer() {
  const kv = new Map<string, string>();
  const channels = new Map<string, Set<(m: string) => void>>();
  const makeClient = (): RedisLikeClient => ({
    get: (k) => kv.get(k) ?? null,
    set: (k, v) => {
      kv.set(k, v);
    },
    del: (k) => {
      kv.delete(k);
    },
    publish: (ch, m) => {
      for (const fn of channels.get(ch) ?? []) fn(m);
    },
    subscribe: (ch, fn) => {
      let subs = channels.get(ch);
      if (!subs) {
        subs = new Set();
        channels.set(ch, subs);
      }
      subs.add(fn);
      return () => subs.delete(fn);
    },
  });
  return { makeClient, kv };
}

describe("redis storage adapter", () => {
  it("round-trips snapshots", async () => {
    const { makeClient } = fakeRedisServer();
    const storage = redis(makeClient());
    const snap = { state: { a: 1 }, session: {}, seq: 3, version: "v1" };
    await storage.set("k", snap);
    expect(await storage.get("k")).toEqual(snap);
    await storage.delete("k");
    expect(await storage.get("k")).toBeUndefined();
  });

  it("fans broadcasts out across nodes — no instance affinity (§8)", async () => {
    const { makeClient } = fakeRedisServer();
    // Two adapters = two server nodes sharing one redis.
    const nodeA = redis(makeClient());
    const nodeB = redis(makeClient());

    interface S {
      log: string[];
    }
    const defFor = (): LiveDefinition<S, "/room", Record<string, unknown>> => ({
      setup: (ctx) => {
        ctx.subscribe("room:1");
        return { log: [] };
      },
      rpc: {
        async shout(_payload: unknown, ctx) {
          ctx.patchState((state) => {
            state.log.push("sent");
          });
          ctx.broadcast("room:1", "hi", { from: "A" });
        },
      },
      on: {
        hi: (state, p: { from: string }) => {
          state.log.push(`recv:${p.from}`);
        },
      },
    });

    const a = await LiveInstance.create({
      id: "A",
      def: defFor(),
      params: {},
      session: {},
      storage: nodeA,
      storageKey: "a",
    });
    const b = await LiveInstance.create({
      id: "B",
      def: defFor(),
      params: {},
      session: {},
      storage: nodeB,
      storageKey: "b",
    });

    await a.handleBatch({
      v: 1,
      instance: "A",
      rpcId: "r1",
      calls: [{ rpc: "shout", payload: {} }],
    });
    await a.idle();
    await b.idle();
    expect(a.state.log).toEqual(["sent"]); // exclude-self holds across the wire
    expect(b.state.log).toEqual(["recv:A"]); // delivered on the other node
  });

  it("drops a malformed (non-JSON) channel message instead of throwing", () => {
    // Capture the raw on-message callback the bus registers with the client.
    let deliver: ((raw: string) => void) | undefined;
    const client: RedisLikeClient = {
      get: () => null,
      set: () => {},
      del: () => {},
      publish: () => {},
      subscribe: (_ch, onMessage) => {
        deliver = onMessage;
        return () => {};
      },
    };
    const storage = redis(client);
    const seen: BroadcastMessage[] = [];
    storage.bus.subscribe("t", "me", (m: BroadcastMessage) => seen.push(m));

    // A truncated / foreign frame (e.g. another service sharing the rpxd: prefix)
    // must not throw inside the client's message-listener callback.
    expect(() => deliver?.("not json{")).not.toThrow();
    expect(seen).toEqual([]);

    // Valid frames still deliver afterwards.
    deliver?.(
      JSON.stringify({ topic: "t", event: "e", payload: 1, senderId: "other", self: false }),
    );
    expect(seen).toHaveLength(1);
  });

  it("routes a failed publish() to an injected event sink as a storage event (#73)", async () => {
    const events: RpxdEvent[] = [];
    const client: RedisLikeClient = {
      get: () => null,
      set: () => {},
      del: () => {},
      publish: () => Promise.reject(new Error("redis down")),
      subscribe: () => () => {},
    };
    const storage = redis(client);
    storage.bus.setEmit?.((e) => events.push(e));
    storage.bus.publish({ topic: "t", event: "e", payload: null, senderId: "s", self: true });
    await Promise.resolve();
    await Promise.resolve();
    const evt = events.find((e) => e.type === "redis-publish-failed");
    expect(evt).toMatchObject({ category: "storage", level: "error" });
    expect(evt?.detail).toMatchObject({ topic: "t" });
  });

  it("handles a failed publish() instead of leaking an unhandled rejection", async () => {
    const client: RedisLikeClient = {
      get: () => null,
      set: () => {},
      del: () => {},
      publish: () => Promise.reject(new Error("redis down")),
      subscribe: () => () => {},
    };
    const storage = redis(client);
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    storage.bus.publish({ topic: "t", event: "e", payload: null, senderId: "s", self: true });
    // Let the rejected publish promise settle.
    await Promise.resolve();
    await Promise.resolve();
    expect(spy).toHaveBeenCalled(); // the failure was caught + reported, not left dangling
    spy.mockRestore();
  });

  it("handles a failed subscribe() instead of leaking an unhandled rejection", async () => {
    const client: RedisLikeClient = {
      get: () => null,
      set: () => {},
      del: () => {},
      publish: () => {},
      subscribe: () => Promise.reject(new Error("redis down")),
    };
    const storage = redis(client);
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const unsubscribe = storage.bus.subscribe("t", "me", () => {});
    // Let the rejected subscribe promise settle.
    await Promise.resolve();
    await Promise.resolve();
    expect(spy).toHaveBeenCalled(); // the failure was caught + reported, not left dangling
    expect(() => unsubscribe()).not.toThrow(); // teardown stays a safe no-op
    spy.mockRestore();
  });

  it("filters self-delivery in the bus layer", () => {
    const { makeClient } = fakeRedisServer();
    const storage = redis(makeClient());
    const seen: string[] = [];
    storage.bus.subscribe("t", "me", (m: BroadcastMessage) => seen.push(m.senderId));
    storage.bus.publish({ topic: "t", event: "e", payload: null, senderId: "me", self: false });
    storage.bus.publish({ topic: "t", event: "e", payload: null, senderId: "me", self: true });
    storage.bus.publish({ topic: "t", event: "e", payload: null, senderId: "other", self: false });
    expect(seen).toEqual(["me", "other"]); // self:true and other senders only
  });
});

describe("RedisBus subscribe multiplexing (#62)", () => {
  /**
   * A fake redis server whose `subscribe` is synchronous (returns the
   * unsubscribe function directly, not a promise) and counts low-level
   * subscribe/unsubscribe calls so tests can assert ref-counting instead of
   * inferring it from side effects.
   */
  function countingFakeClient() {
    const listeners = new Map<string, Set<(m: string) => void>>();
    let subscribeCalls = 0;
    let unsubscribeCalls = 0;
    const client: RedisLikeClient = {
      get: () => null,
      set: () => {},
      del: () => {},
      publish: (ch, m) => {
        for (const fn of listeners.get(ch) ?? []) fn(m);
      },
      subscribe: (ch, fn) => {
        subscribeCalls++;
        let set = listeners.get(ch);
        if (!set) {
          set = new Set();
          listeners.set(ch, set);
        }
        set.add(fn);
        return () => {
          unsubscribeCalls++;
          set?.delete(fn);
        };
      },
    };
    return {
      client,
      getSubscribeCalls: () => subscribeCalls,
      getUnsubscribeCalls: () => unsubscribeCalls,
    };
  }

  /** A tick of the microtask queue — enough for a resolved promise's `.then` to run. */
  async function tick(times = 2) {
    for (let i = 0; i < times; i++) await Promise.resolve();
  }

  it("multiplexes N local subscribers into ONE client.subscribe call and ONE parse per message", () => {
    const { client, getSubscribeCalls } = countingFakeClient();
    const storage = redis(client);
    const parseSpy = vi.spyOn(JSON, "parse");
    const seenA: BroadcastMessage[] = [];
    const seenB: BroadcastMessage[] = [];

    storage.bus.subscribe("t", "a", (m) => seenA.push(m));
    storage.bus.subscribe("t", "b", (m) => seenB.push(m));
    expect(getSubscribeCalls()).toBe(1); // one channel, one low-level subscribe

    storage.bus.publish({ topic: "t", event: "e", payload: 1, senderId: "other", self: false });

    expect(parseSpy).toHaveBeenCalledTimes(1); // parsed once, fanned out to both
    expect(seenA).toHaveLength(1);
    expect(seenB).toHaveLength(1);
    parseSpy.mockRestore();
  });

  it("applies exclude-self per subscriber during fan-out", () => {
    const { client } = countingFakeClient();
    const storage = redis(client);
    const seenA: BroadcastMessage[] = [];
    const seenB: BroadcastMessage[] = [];

    storage.bus.subscribe("t", "a", (m) => seenA.push(m));
    storage.bus.subscribe("t", "b", (m) => seenB.push(m));
    storage.bus.publish({ topic: "t", event: "e", payload: 1, senderId: "a", self: false });

    expect(seenA).toEqual([]); // excluded — sender was "a"
    expect(seenB).toHaveLength(1); // "b" still gets it off the same shared delivery
  });

  it("issues exactly one redis unsubscribe when the last local subscriber leaves", async () => {
    const { client, getSubscribeCalls, getUnsubscribeCalls } = countingFakeClient();
    const storage = redis(client);

    const unsubA = storage.bus.subscribe("t", "a", () => {});
    const unsubB = storage.bus.subscribe("t", "b", () => {});
    await tick();
    expect(getSubscribeCalls()).toBe(1);

    unsubA();
    await tick();
    expect(getUnsubscribeCalls()).toBe(0); // "b" is still riding the channel

    unsubB();
    await tick();
    expect(getUnsubscribeCalls()).toBe(1); // last leaver tears down the shared subscribe
  });

  it("issues a fresh client.subscribe after full teardown and re-subscribe", async () => {
    const { client, getSubscribeCalls } = countingFakeClient();
    const storage = redis(client);

    const unsub = storage.bus.subscribe("t", "a", () => {});
    await tick();
    expect(getSubscribeCalls()).toBe(1);

    unsub();
    await tick();

    storage.bus.subscribe("t", "a", () => {});
    expect(getSubscribeCalls()).toBe(2); // fresh subscribe — the old entry is gone
  });

  it("an idempotent unsubscribe only removes its own subscriber", async () => {
    const { client, getUnsubscribeCalls } = countingFakeClient();
    const storage = redis(client);

    const unsubA = storage.bus.subscribe("t", "a", () => {});
    const unsubB = storage.bus.subscribe("t", "b", () => {});
    await tick();

    unsubA();
    unsubA(); // calling twice must not double-teardown or affect "b"
    await tick();
    expect(getUnsubscribeCalls()).toBe(0); // "b" still present

    unsubB();
    await tick();
    expect(getUnsubscribeCalls()).toBe(1);
  });

  it("async race: a second local subscriber arriving before client.subscribe resolves joins the pending entry", async () => {
    let subscribeCalls = 0;
    let capturedResolve: ((u: () => void) => void) | undefined;
    const client: RedisLikeClient = {
      get: () => null,
      set: () => {},
      del: () => {},
      publish: () => {},
      subscribe: () => {
        subscribeCalls++;
        return new Promise<() => void>((resolve) => {
          capturedResolve = resolve;
        });
      },
    };
    const storage = redis(client);

    storage.bus.subscribe("t", "a", () => {});
    storage.bus.subscribe("t", "b", () => {}); // arrives while the first subscribe is still pending
    expect(subscribeCalls).toBe(1); // no second low-level subscribe issued

    let unsubCalls = 0;
    capturedResolve?.(() => {
      unsubCalls++;
    });
    await tick();
    expect(unsubCalls).toBe(0); // nobody has torn down yet
  });

  it("teardown before the pending client.subscribe resolves still calls the eventual unsub exactly once", async () => {
    let capturedResolve: ((u: () => void) => void) | undefined;
    const client: RedisLikeClient = {
      get: () => null,
      set: () => {},
      del: () => {},
      publish: () => {},
      subscribe: () =>
        new Promise<() => void>((resolve) => {
          capturedResolve = resolve;
        }),
    };
    const storage = redis(client);

    const unsub = storage.bus.subscribe("t", "a", () => {});
    unsub(); // last (only) subscriber leaves before the client.subscribe promise settles

    let unsubCalls = 0;
    capturedResolve?.(() => {
      unsubCalls++;
    });
    await tick();
    expect(unsubCalls).toBe(1); // the "cancelled" channel entry still tears down once resolved
  });

  it("still drops a malformed message once, without delivering to any subscriber", () => {
    let deliver: ((raw: string) => void) | undefined;
    const client: RedisLikeClient = {
      get: () => null,
      set: () => {},
      del: () => {},
      publish: () => {},
      subscribe: (_ch, onMessage) => {
        deliver = onMessage;
        return () => {};
      },
    };
    const storage = redis(client);
    const seenA: BroadcastMessage[] = [];
    const seenB: BroadcastMessage[] = [];
    storage.bus.subscribe("t", "a", (m) => seenA.push(m));
    storage.bus.subscribe("t", "b", (m) => seenB.push(m));

    expect(() => deliver?.("not json{")).not.toThrow();
    expect(seenA).toEqual([]);
    expect(seenB).toEqual([]);
  });

  it("drain() awaits in-flight publishes and empties the pending set; publish stays a non-rejecting void", async () => {
    // A client whose publish returns a promise we resolve on demand, so we can
    // observe drain() gating on the in-flight publish rather than racing it.
    let resolvePublish: (() => void) | undefined;
    let localDelivered = 0;
    const client: RedisLikeClient = {
      get: () => null,
      set: () => {},
      del: () => {},
      publish: () =>
        new Promise<void>((resolve) => {
          resolvePublish = resolve;
        }),
      subscribe: () => () => {},
    };
    const storage = redis(client);
    storage.bus.subscribe("t", "me", () => {
      localDelivered++;
    });

    // publish is fire-and-forget: it returns synchronously (undefined) and never rejects.
    const ret = storage.bus.publish({
      topic: "t",
      event: "e",
      payload: null,
      senderId: "other",
      self: false,
    });
    expect(ret).toBeUndefined();

    // drain() must NOT resolve while the publish is still in flight.
    let drainResolved = false;
    const drained = storage.bus.drain?.().then(() => {
      drainResolved = true;
    });
    await tick();
    expect(drainResolved).toBe(false); // gated on the pending publish

    // Settle the in-flight publish; drain() now resolves and the pending set empties.
    resolvePublish?.();
    await drained;
    expect(drainResolved).toBe(true);

    // A second drain with nothing pending resolves immediately (set was cleared).
    let secondResolved = false;
    await storage.bus.drain?.().then(() => {
      secondResolved = true;
    });
    expect(secondResolved).toBe(true);
    // Fake client didn't loop delivery back, so no local delivery happened here —
    // the point is drain tracked the PUBLISH acceptance, not remote processing.
    expect(localDelivered).toBe(0);
  });

  it("drain() resolves even when the in-flight publish rejects (publish never leaks a rejection)", async () => {
    const client: RedisLikeClient = {
      get: () => null,
      set: () => {},
      del: () => {},
      publish: () => Promise.reject(new Error("redis down")),
      subscribe: () => () => {},
    };
    const storage = redis(client);
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    expect(() =>
      storage.bus.publish({ topic: "t", event: "e", payload: null, senderId: "s", self: true }),
    ).not.toThrow();
    // drain must not reject — the failing publish is caught by publish's own .catch,
    // and drain only waits for the in-flight tracking promise to settle.
    await expect(storage.bus.drain?.()).resolves.toBeUndefined();
    spy.mockRestore();
  });

  it("still catches a rejected client.subscribe (no unhandled rejection) with multiple subscribers pending", async () => {
    const client: RedisLikeClient = {
      get: () => null,
      set: () => {},
      del: () => {},
      publish: () => {},
      subscribe: () => Promise.reject(new Error("redis down")),
    };
    const storage = redis(client);
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    const unsubA = storage.bus.subscribe("t", "a", () => {});
    const unsubB = storage.bus.subscribe("t", "b", () => {});
    await tick();

    expect(spy).toHaveBeenCalled();
    expect(() => unsubA()).not.toThrow();
    expect(() => unsubB()).not.toThrow();
    spy.mockRestore();
  });
});
