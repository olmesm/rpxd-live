import {
  type BroadcastMessage,
  isRedirect,
  LocalBus,
  live,
  memory,
  type PubSubBus,
  redirect,
  type StorageAdapter,
} from "@rpxd/core";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { testLive } from "../src/index.ts";

interface Todo {
  id: string;
  text: string;
}

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

let counter = 0;

const todosRoute = live("/todos")
  .setup(() => ({ todos: [] as Todo[], log: [] as string[] }))
  .rpc("add", (r) =>
    r.input(z.object({ text: z.string().min(1) })).handler(async ({ text }, ctx) => {
      ctx.patchState((s) => {
        s.todos.push({ id: `srv-${++counter}`, text });
      });
    }),
  )
  .rpc("explode", (r) =>
    r.handler(async () => {
      throw new Error("db down");
    }),
  )
  .render(({ state, rpc }) => ({ state, rpc }) as unknown);

describe("testLive: mount + typed rpc calls", () => {
  it("mounts the route and exposes live state", async () => {
    const t = await testLive(todosRoute);
    expect(t.state.todos).toEqual([]);
    await t.dispose();
  });

  it("t.rpc.* invokes the handler and resolves on ack", async () => {
    const t = await testLive(todosRoute);
    await t.rpc.add({ text: "milk" });
    expect(t.state.todos).toHaveLength(1);
    expect(t.state.todos[0]?.text).toBe("milk");
    // the ack envelope was captured
    const ack = t.envelopes.find((e) => e.rpcId);
    expect(ack?.patches?.[0]?.path).toEqual(["todos", 0]);
    await t.dispose();
  });

  it("rejects when the handler throws, carrying the ack error", async () => {
    const t = await testLive(todosRoute);
    await expect(t.rpc.explode()).rejects.toThrow("db down");
    await t.dispose();
  });

  it("rejects on server-side input validation failure", async () => {
    const t = await testLive(todosRoute);
    await expect(t.rpc.add({ text: "" })).rejects.toMatchObject({
      name: "ValidationError",
      message: expect.stringContaining('Invalid payload for rpc "add"'),
    });
    expect(t.state.todos).toHaveLength(0);
    await t.dispose();
  });

  it("t.call is the untyped escape hatch", async () => {
    const t = await testLive(todosRoute);
    await t.call("add", { text: "via call" });
    expect(t.state.todos[0]?.text).toBe("via call");
    await expect(t.call("nope")).rejects.toThrow('Unknown rpc "nope"');
    await t.dispose();
  });

  it("coalesces same-tick rpc calls into one batch/ack (§6)", async () => {
    const t = await testLive(todosRoute);
    // Both calls fire synchronously, in the same tick — mirrors two rpc.*
    // calls from a single event handler on the real client.
    const p1 = t.rpc.add({ text: "milk" });
    const p2 = t.rpc.add({ text: "eggs" });
    await Promise.all([p1, p2]);
    expect(t.state.todos.map((td) => td.text)).toEqual(["milk", "eggs"]);
    // One combined ack envelope, not two.
    const acks = t.envelopes.filter((e) => e.rpcId);
    expect(acks).toHaveLength(1);
    expect(acks[0]?.patches).toHaveLength(2);
    const rpcIds = new Set(acks.map((e) => e.rpcId));
    expect(rpcIds.size).toBe(1);
    await t.dispose();
  });

  it("calls in separate ticks still produce separate batches", async () => {
    const t = await testLive(todosRoute);
    await t.rpc.add({ text: "milk" });
    await t.rpc.add({ text: "eggs" });
    const acks = t.envelopes.filter((e) => e.rpcId);
    expect(acks).toHaveLength(2);
    expect(acks[0]?.rpcId).not.toBe(acks[1]?.rpcId);
    await t.dispose();
  });

  it("a same-tick batch failure rejects every call in the batch (mirrors client op semantics)", async () => {
    const t = await testLive(todosRoute);
    const p1 = t.rpc.add({ text: "milk" });
    const p2 = t.rpc.explode();
    await expect(p1).rejects.toThrow("db down");
    await expect(p2).rejects.toThrow("db down");
    // "milk" ran before the throwing call, so its patchState write rides the
    // one error ack (sibling-write all-or-nothing is userland, §3) — the
    // point under test is that both promises settle off that single ack.
    expect(t.state.todos.map((td) => td.text)).toEqual(["milk"]);
    const acks = t.envelopes.filter((e) => e.rpcId);
    expect(acks).toHaveLength(1);
    expect(acks[0]?.error).toBeDefined();
    await t.dispose();
  });
});

describe("testLive: streaming + settled", () => {
  const streamRoute = live("/stream")
    .setup(() => ({ items: [] as string[], running: false }))
    .rpc("run", (r) =>
      r.handler(async (_p, ctx) => {
        ctx.patchState((s) => {
          s.running = true;
        });
        for (let i = 1; i <= 3; i++) {
          await tick();
          ctx.patchState((s) => {
            s.items.push(`item-${i}`);
          });
        }
        ctx.patchState((s) => {
          s.running = false;
        });
      }),
    )
    .render(() => null);

  it("settled() waits out in-flight rpcs, flush timers, and the queue", async () => {
    const t = await testLive(streamRoute);
    const p = t.call("run");
    await t.settled();
    expect(t.state.items).toEqual(["item-1", "item-2", "item-3"]);
    expect(t.state.running).toBe(false);
    // mid-handler flushes were captured as chunk envelopes (no rpcId)
    expect(t.envelopes.some((e) => e.patches && !e.rpcId)).toBe(true);
    await p;
    await t.dispose();
  });
});

describe("testLive: broadcast injection + search params", () => {
  const roomRoute = live("/room")
    .setup((ctx) => {
      ctx.subscribe("room:1");
      return { log: [] as string[], filter: "all" };
    })
    // "user.joined" isn't in Register["events"], so its payload is `unknown`
    // (strict by default) — narrow it at the boundary.
    .on("user.joined", (state, p) => {
      const { name } = p as { name: string };
      state.log.push(`joined:${name}`);
    })
    .load(async ({ search }, ctx) => {
      ctx.patchState((s) => {
        s.filter = search.filter ?? "all";
      });
    })
    .render(() => null);

  it("injects broadcasts as if a peer instance published them", async () => {
    const t = await testLive(roomRoute);
    t.broadcast("room:1", "user.joined", { name: "ada" });
    await t.settled();
    expect(t.state.log).toEqual(["joined:ada"]);
    await t.dispose();
  });

  it("settled() drains an async bus so a broadcast's reaction is visible (#66)", async () => {
    // A bus whose local delivery is deferred until drain() runs — modelling a
    // network bus (redis) where publish is fire-and-forget and delivery lands
    // out of band. settled() must await drain() or the reaction is invisible.
    class DeferredBus implements PubSubBus {
      #inner = new LocalBus();
      #pending: Array<() => void> = [];
      publish(msg: BroadcastMessage): void {
        // fire-and-forget: queue local delivery, return immediately (void).
        this.#pending.push(() => this.#inner.publish(msg));
      }
      subscribe(topic: string, id: string, fn: (m: BroadcastMessage) => void): () => void {
        return this.#inner.subscribe(topic, id, fn);
      }
      async drain(): Promise<void> {
        const jobs = this.#pending;
        this.#pending = [];
        for (const job of jobs) job();
        await Promise.resolve();
      }
    }
    const base = memory();
    const storage: StorageAdapter = { ...base, bus: new DeferredBus() };

    const t = await testLive(roomRoute, { storage });
    t.broadcast("room:1", "user.joined", { name: "ada" });
    // Without settled() draining the bus, delivery is still pending here.
    expect(t.state.log).toEqual([]);
    await t.settled();
    expect(t.state.log).toEqual(["joined:ada"]); // settled() awaited the deferred delivery
    await t.dispose();
  });

  it("navigate runs guard+load, writing page state (§7)", async () => {
    const t = await testLive(roomRoute);
    await t.navigate({ filter: "done" });
    expect(t.state.filter).toBe("done");
    expect(t.envelopes.at(-1)?.patches?.[0]?.path).toEqual(["filter"]);
    await t.dispose();
  });

  it("shares a storage adapter for multiplayer tests", async () => {
    const storage = memory();
    const chatRoute = live("/chat")
      .setup((ctx) => {
        ctx.subscribe("chat");
        return { log: [] as string[] };
      })
      .rpc("send", (r) =>
        r.handler(async ({ text }: { text: string }, ctx) => {
          ctx.broadcast("chat", "msg", { text });
        }),
      )
      // unregistered event → `unknown` payload; narrow at the boundary.
      .on("msg", (state, p) => {
        state.log.push((p as { text: string }).text);
      })
      .render(({ rpc }) => ({ rpc }) as unknown);

    const a = await testLive(chatRoute, { storage, id: "A" });
    const b = await testLive(chatRoute, { storage, id: "B" });
    await a.rpc.send({ text: "hi" });
    await a.settled();
    await b.settled();
    expect(a.state.log).toEqual([]); // exclude-self default
    expect(b.state.log).toEqual(["hi"]);
    await a.dispose();
    await b.dispose();
  });
});

describe("testLive: mount lifecycle (guard → setup → load)", () => {
  it("runs the loader at mount — initial state is loader-populated, no navigate()", async () => {
    const route = live("/inbox")
      .setup(() => ({ items: [] as string[], loaded: false }))
      .load(async (_url, ctx) => {
        await tick();
        ctx.patchState((s) => {
          s.items = ["a", "b"];
          s.loaded = true;
        });
      })
      .render(() => null);
    const t = await testLive(route);
    expect(t.state.loaded).toBe(true);
    expect(t.state.items).toEqual(["a", "b"]);
    // the loader's flush is on the wire, as a mounting client would see it
    expect(t.envelopes.some((e) => e.patches?.some((p) => p.path[0] === "loaded"))).toBe(true);
    await t.dispose();
  });

  it("mounts with the initial search params", async () => {
    const route = live("/list")
      .setup(() => ({ filter: "" }))
      .load(({ search }, ctx) => {
        ctx.patchState((s) => {
          s.filter = search.filter ?? "all";
        });
      })
      .render(() => null);
    const t = await testLive(route, { search: { filter: "done" } });
    expect(t.state.filter).toBe("done");
    await t.dispose();
  });

  it("rejects with the redirect when the guard denies (§10)", async () => {
    let setupRan = false;
    const route = live("/admin")
      .setup(() => {
        setupRan = true;
        return { secret: "s3cr3t" };
      })
      .guard((_url, ctx) => {
        if (!(ctx.session as { user?: string }).user) throw redirect("/login");
      })
      .render(() => null);
    await expect(testLive(route)).rejects.toSatisfy(
      (e) => isRedirect(e) && e.location === "/login" && e.status === 302,
    );
    expect(setupRan).toBe(false); // a denied mount allocates nothing
    const t = await testLive(route, { session: { user: "ada" } });
    expect(t.state.secret).toBe("s3cr3t");
    await t.dispose();
  });

  it("runs guard before setup, and setup before load", async () => {
    const order: string[] = [];
    const route = live("/gated")
      .setup(() => {
        order.push("setup");
        return {};
      })
      .guard(({ search }) => {
        order.push(`guard:${search.q ?? ""}`);
      })
      .load(() => {
        order.push("load");
      })
      .render(() => null);
    const t = await testLive(route, { search: { q: "x" } });
    expect(order).toEqual(["guard:x", "setup", "load"]);
    await t.dispose();
  });

  it("disposes the half-built instance when the loader redirects (no leaked subscription)", async () => {
    const base = memory();
    let active = 0;
    const storage: StorageAdapter = {
      ...base,
      bus: {
        publish: (msg) => base.bus.publish(msg),
        subscribe: (topic, subscriberId, fn) => {
          active++;
          const unsub = base.bus.subscribe(topic, subscriberId, fn);
          return () => {
            active--;
            unsub();
          };
        },
      },
    };
    const route = live("/gone")
      .setup((ctx) => {
        ctx.subscribe("room:1");
        return {};
      })
      .load(() => {
        throw redirect("/away");
      })
      .render(() => null);
    await expect(testLive(route, { storage })).rejects.toMatchObject({ location: "/away" });
    expect(active).toBe(0); // setup's subscription was torn down with the instance
  });
});

describe("testLive: path params + dispose", () => {
  it("passes typed path params through to setup", async () => {
    const route = live("/org/$orgId")
      .setup((ctx) => ({ orgId: ctx.params.orgId }))
      .render(() => null);
    const t = await testLive(route, { params: { orgId: "acme" } });
    expect(t.state.orgId).toBe("acme");
    await t.dispose();
  });

  it("dispose aborts in-flight handler signals", async () => {
    let aborted = false;
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const route = live("/watch")
      .setup(() => ({ n: 0 }))
      .rpc("watch", (r) =>
        r.handler(async (_p, ctx) => {
          ctx.signal.addEventListener("abort", () => {
            aborted = true;
          });
          await gate;
        }),
      )
      .render(() => null);
    const t = await testLive(route);
    const p = t.call("watch");
    await tick();
    await t.dispose();
    expect(aborted).toBe(true);
    release();
    await p;
  });
});
