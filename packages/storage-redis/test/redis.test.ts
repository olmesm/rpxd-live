import type { BroadcastMessage, LiveDefinition } from "@rpxd/core";
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
