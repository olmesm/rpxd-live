import { live, memory } from "@rpxd/core";
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
    .on("user.joined", (state, p: { name: string }) => {
      state.log.push(`joined:${p.name}`);
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
      .on("msg", (state, p: { text: string }) => {
        state.log.push(p.text);
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
