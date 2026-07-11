import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { RpxdEvent, RpxdEventSink } from "../src/events.ts";
import { LiveInstance } from "../src/instance.ts";
import type { LiveDefinition, Mutator, SearchParams } from "../src/live.ts";
import { type Envelope, PROTOCOL_VERSION, type RpcBatch } from "../src/protocol.ts";
import { redirect } from "../src/redirect.ts";
import { memory, type StorageAdapter } from "../src/storage.ts";
import { isSuperseded } from "../src/supersede.ts";

interface TodoState {
  todos: { id: string; text: string }[];
  log: string[];
  answer: string;
  importing?: boolean;
  lastError?: string;
  filter?: string;
  loading?: boolean;
  loadError?: string;
}

type Session = { filter?: string };
type Mut = Mutator<TodoState>;

let nextId = 0;
const uid = (prefix: string) => `${prefix}-${++nextId}`;
const tick = () => new Promise<void>((r) => setTimeout(r, 0));

const gates: Record<string, () => void> = {};
const gate = (name: string) =>
  new Promise<void>((resolve) => {
    gates[name] = resolve;
  });

function batch(rpc: string, payload: unknown = {}, rpcId = uid("rpc")): RpcBatch {
  return { v: PROTOCOL_VERSION, instance: "i", rpcId, calls: [{ rpc, payload }] };
}

async function make(
  def: LiveDefinition<TodoState, "/t/$id", Session>,
  opts: {
    storage?: StorageAdapter;
    key?: string;
    session?: Session;
    id?: string;
    emit?: RpxdEventSink;
  } = {},
) {
  const storage = opts.storage ?? memory();
  const inst = await LiveInstance.create({
    id: opts.id ?? uid("inst"),
    def,
    params: { id: "42" },
    session: opts.session ?? {},
    storage,
    storageKey: opts.key ?? uid("key"),
    emit: opts.emit,
  });
  const envelopes: Envelope[] = [];
  inst.addListener((env) => envelopes.push(env));
  return { inst, envelopes, storage };
}

const initial = (): TodoState => ({ todos: [], log: [], answer: "" });

const baseDef: LiveDefinition<TodoState, "/t/$id", Session> = {
  setup: () => initial(),
  rpc: {
    add: {
      async handler({ text }: { text: string }, ctx) {
        ctx.patchState(((s) => {
          s.todos.push({ id: uid("todo"), text });
        }) as Mut);
      },
    },
    fast: {
      async handler(_p, ctx) {
        ctx.patchState(((s) => {
          s.log.push("fast");
        }) as Mut);
      },
    },
  },
};

describe("LiveInstance basics", () => {
  it("mounts with a full-snapshot seq and acks a plain rpc with combined patches", async () => {
    const { inst, envelopes } = await make(baseDef);
    expect(inst.seq).toBe(1); // setup emitted the initial full envelope

    await inst.handleBatch(batch("add", { text: "milk" }));
    expect(inst.state.todos).toHaveLength(1);
    expect(envelopes).toHaveLength(1); // same-tick patchState rides the ack
    const ack = envelopes[0] as Envelope;
    expect(ack.rpcId).toBeDefined();
    expect(ack.seq).toBe(2);
    expect(ack.patches?.[0]?.path).toEqual(["todos", 0]);
  });

  it("coalesces a multi-call batch into one combined patch + one ack", async () => {
    const { inst, envelopes } = await make(baseDef);
    await inst.handleBatch({
      v: PROTOCOL_VERSION,
      instance: "i",
      rpcId: "b1",
      calls: [
        { rpc: "add", payload: { text: "a" } },
        { rpc: "add", payload: { text: "b" } },
      ],
    });
    expect(inst.state.todos).toHaveLength(2);
    expect(envelopes).toHaveLength(1);
    expect(envelopes[0]?.patches).toHaveLength(2);
    expect(envelopes[0]?.rpcId).toBe("b1");
  });

  it("dedupes resent batches by rpcId without re-running", async () => {
    const { inst, envelopes } = await make(baseDef);
    await inst.handleBatch(batch("add", { text: "once" }, "dup"));
    await inst.handleBatch(batch("add", { text: "once" }, "dup"));
    expect(inst.state.todos).toHaveLength(1);
    expect(envelopes).toHaveLength(2);
    expect(envelopes[1]?.seq).toBe(envelopes[0]?.seq); // re-acked, not re-run
  });

  it("acks unknown rpcs with an error and leaves state untouched", async () => {
    const { inst, envelopes } = await make(baseDef);
    await inst.handleBatch(batch("nope"));
    expect(envelopes[0]?.error?.message).toContain('Unknown rpc "nope"');
    expect(inst.state.todos).toHaveLength(0);
  });

  it("emits a full snapshot on resync()", async () => {
    const { inst, envelopes } = await make(baseDef);
    inst.resync();
    expect(envelopes[0]?.full).toEqual({ state: inst.state, session: inst.session });
  });
});

describe("batch-size cap (§11 DoS guard)", () => {
  const addCalls = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ rpc: "add", payload: { text: `t${i}` } }));

  it("error-acks an over-cap batch and runs none of its calls", async () => {
    const inst = await LiveInstance.create({
      id: "i",
      def: baseDef,
      params: { id: "42" },
      session: {},
      storage: memory(),
      storageKey: uid("key"),
      maxBatchCalls: 2,
    });
    const envelopes: Envelope[] = [];
    inst.addListener((env) => envelopes.push(env));

    await inst.handleBatch({
      v: PROTOCOL_VERSION,
      instance: "i",
      rpcId: "big",
      calls: addCalls(3),
    });

    expect(inst.state.todos).toHaveLength(0); // rejected before any handler ran
    expect(envelopes).toHaveLength(1);
    expect(envelopes[0]?.rpcId).toBe("big");
    expect(envelopes[0]?.error?.message).toMatch(/batch/i);
    expect(envelopes[0]?.patches).toEqual([]);
  });

  it("runs a batch exactly at the cap", async () => {
    const inst = await LiveInstance.create({
      id: "i",
      def: baseDef,
      params: { id: "42" },
      session: {},
      storage: memory(),
      storageKey: uid("key"),
      maxBatchCalls: 2,
    });
    const envelopes: Envelope[] = [];
    inst.addListener((env) => envelopes.push(env));

    await inst.handleBatch({
      v: PROTOCOL_VERSION,
      instance: "i",
      rpcId: "ok",
      calls: addCalls(2),
    });

    expect(inst.state.todos).toHaveLength(2);
    expect(envelopes[0]?.error).toBeUndefined();
  });

  it("defaults to a finite cap (256) when none is configured", async () => {
    const { inst, envelopes } = await make(baseDef);
    await inst.handleBatch({
      v: PROTOCOL_VERSION,
      instance: "i",
      rpcId: "flood",
      calls: addCalls(257),
    });
    expect(inst.state.todos).toHaveLength(0);
    expect(envelopes[0]?.error?.message).toMatch(/batch/i);
  });
});

describe("concurrency (§3): handlers never block the instance", () => {
  it("runs a fast rpc while a slow handler awaits", async () => {
    const def: LiveDefinition<TodoState, "/t/$id", Session> = {
      setup: () => initial(),
      rpc: {
        ...baseDef.rpc,
        slow: {
          async handler(_p, ctx) {
            ctx.patchState(((s) => {
              s.log.push("slow:start");
            }) as Mut);
            await gate("slow");
            ctx.patchState(((s) => {
              s.log.push("slow:end");
            }) as Mut);
          },
        },
      },
    };
    const { inst } = await make(def);
    const slow = inst.handleBatch(batch("slow"));
    await tick(); // let slow reach its await
    await inst.handleBatch(batch("fast")); // completes while slow is parked
    expect(inst.state.log).toEqual(["slow:start", "fast"]);
    gates.slow?.();
    await slow;
    expect(inst.state.log).toEqual(["slow:start", "fast", "slow:end"]);
  });

  it("ctx.state reads are live — current even after awaits", async () => {
    const seen: string[][] = [];
    const def: LiveDefinition<TodoState, "/t/$id", Session> = {
      setup: () => initial(),
      rpc: {
        ...baseDef.rpc,
        watcher: {
          async handler(_p, ctx) {
            seen.push([...ctx.state.log]);
            await gate("watch");
            seen.push([...ctx.state.log]); // must see "fast" written meanwhile
          },
        },
      },
    };
    const { inst } = await make(def);
    const run = inst.handleBatch(batch("watcher"));
    await tick();
    await inst.handleBatch(batch("fast"));
    gates.watch?.();
    await run;
    expect(seen).toEqual([[], ["fast"]]);
  });

  it("ctx.state rejects writes with a helpful error", async () => {
    let error: Error | undefined;
    const def: LiveDefinition<TodoState, "/t/$id", Session> = {
      setup: () => initial(),
      rpc: {
        mutant: {
          async handler(_p, ctx) {
            try {
              // biome-ignore lint/suspicious/noExplicitAny: intentional violation
              (ctx.state as any).answer = "nope";
            } catch (e) {
              error = e as Error;
            }
          },
        },
      },
    };
    const { inst } = await make(def);
    await inst.handleBatch(batch("mutant"));
    expect(error?.message).toContain("patchState");
    expect(inst.state.answer).toBe("");
  });
});

describe("streaming + append op (§2, §3)", () => {
  it("flushes one envelope per patchState tick; ack carries the final-tick patches", async () => {
    const def: LiveDefinition<TodoState, "/t/$id", Session> = {
      setup: () => initial(),
      rpc: {
        stream: {
          async handler(_p, ctx) {
            ctx.patchState(((s) => {
              s.log.push("g1");
            }) as Mut);
            await tick(); // force a flush boundary
            ctx.patchState(((s) => {
              s.log.push("g2");
            }) as Mut);
          },
        },
      },
    };
    const { inst, envelopes } = await make(def);
    await inst.handleBatch(batch("stream"));
    expect(inst.state.log).toEqual(["g1", "g2"]);
    expect(envelopes).toHaveLength(2); // chunk envelope + ack (with g2)
    expect(envelopes[0]?.rpcId).toBeUndefined();
    expect(envelopes[1]?.rpcId).toBeDefined();
  });

  it("compiles string-suffix growth to append patches carrying only the delta", async () => {
    const def: LiveDefinition<TodoState, "/t/$id", Session> = {
      setup: () => initial(),
      rpc: {
        ask: {
          async handler(_p, ctx) {
            ctx.patchState(((s) => {
              s.answer = "Hello";
            }) as Mut);
            await tick();
            ctx.patchState(((s) => {
              s.answer += ", world";
            }) as Mut);
            await tick();
            ctx.patchState(((s) => {
              s.answer += "!";
            }) as Mut);
          },
        },
      },
    };
    const { inst, envelopes } = await make(def);
    await inst.handleBatch(batch("ask"));
    expect(inst.state.answer).toBe("Hello, world!");
    const ops = envelopes.flatMap((e) => e.patches ?? []);
    expect(ops[0]).toEqual({ op: "replace", path: ["answer"], value: "Hello" });
    expect(ops[1]).toEqual({ op: "append", path: ["answer"], value: ", world" });
    expect(ops[2]).toEqual({ op: "append", path: ["answer"], value: "!" });
  });
});

describe("per-rpc write isolation on throw (§3)", () => {
  const def: LiveDefinition<TodoState, "/t/$id", Session> = {
    setup: () => initial(),
    rpc: {
      note: {
        async handler(_p, ctx) {
          ctx.patchState(((s) => {
            s.log.push("note");
          }) as Mut);
        },
      },
      boom: {
        async handler(_p, ctx) {
          ctx.patchState(((s) => {
            s.log.push("boom-write");
          }) as Mut);
          throw new Error("boom");
        },
      },
    },
  };

  it("keeps an earlier sibling call's committed writes when a later call throws", async () => {
    const { inst, envelopes } = await make(def);
    await inst.handleBatch({
      v: PROTOCOL_VERSION,
      instance: "i",
      rpcId: "mix1",
      calls: [
        { rpc: "note", payload: {} },
        { rpc: "boom", payload: {} },
      ],
    });
    // Every write streams to the pending list as it happens (§3): the failing
    // call's own write rides the error ack too, and the sibling's write stands.
    expect(inst.state.log).toEqual(["note", "boom-write"]);
    expect(envelopes.at(-1)?.error?.message).toBe("boom");
  });
});

describe("loadForRender render gate (§12)", () => {
  it("await-before-patch: render waits for the loader's first patch (crawlable)", async () => {
    const def: LiveDefinition<TodoState, "/t/$id", Session> = {
      setup: () => initial(),
      load: async (_url, ctx) => {
        await tick();
        ctx.patchState(((s) => {
          s.log.push("data");
        }) as Mut);
      },
    };
    const { inst } = await make(def);
    await inst.loadForRender({});
    expect(inst.state.log).toEqual(["data"]); // data is present at render time
  });

  it("sync projection: render opens on the first patch, not the awaited data", async () => {
    const def: LiveDefinition<TodoState, "/t/$id", Session> = {
      setup: () => initial(),
      load: async (_url, ctx) => {
        ctx.patchState(((s) => {
          s.log.push("chrome");
        }) as Mut);
        await gate("load"); // held open past the render
        ctx.patchState(((s) => {
          s.log.push("data");
        }) as Mut);
      },
    };
    const { inst } = await make(def);
    await inst.loadForRender({});
    expect(inst.state.log).toEqual(["chrome"]); // rendered before the awaited data
    gates.load?.();
  });

  it("does not hang when a second render reconcile supersedes an in-flight one", async () => {
    let calls = 0;
    const def: LiveDefinition<TodoState, "/t/$id", Session> = {
      setup: () => initial(),
      load: async (_url, ctx) => {
        if (++calls === 1) await gate("first"); // first run blocks before any patch
        ctx.patchState(((s) => {
          s.log.push(`load${calls}`);
        }) as Mut);
      },
    };
    const { inst } = await make(def);
    const first = inst.loadForRender({}); // starts run 1, awaits, no patch yet
    const second = inst.loadForRender({}); // supersedes run 1
    // The superseded first render must resolve rather than orphan its gate.
    await expect(first).resolves.toBeUndefined();
    await expect(second).resolves.toBeUndefined();
    gates.first?.(); // let the superseded run drain
  });

  it("emits a redirect thrown after the first patch instead of dropping it silently (§12)", async () => {
    const events: RpxdEvent[] = [];
    const def: LiveDefinition<TodoState, "/t/$id", Session> = {
      setup: () => initial(),
      load: async (_url, ctx) => {
        ctx.patchState(((s) => {
          s.log.push("chrome");
        }) as Mut);
        await gate("lateRedirect"); // held until the first patch has flushed
        throw redirect("/too-late");
      },
    };
    const { inst } = await make(def, { emit: (e) => events.push(e) });
    await inst.loadForRender({}); // resolves at the first patch
    gates.lateRedirect?.(); // the loader now throws its redirect mid-stream
    await tick();
    await tick();
    // The dropped redirect leaves a structured server-side trace, and nothing crashed.
    const dropped = events.find((e) => e.type === "load-redirect-ignored");
    expect(dropped).toMatchObject({ category: "instance", level: "warn" });
    expect(dropped?.detail).toMatchObject({ location: "/too-late" });
    expect(inst.state.log).toEqual(["chrome"]);
  });

  it("an unrelated flush during an await-first load does not open the render gate", async () => {
    const def: LiveDefinition<TodoState, "/t/$id", Session> = {
      setup: () => initial(),
      load: async (_url, ctx) => {
        await gate("load"); // awaits before its first patch
        ctx.patchState(((s) => {
          s.log.push("data");
        }) as Mut);
      },
      rpc: {
        slow: {
          async handler(_p, ctx) {
            ctx.patchState(((s) => {
              s.log.push("rpc");
            }) as Mut); // schedules a coalescing #flushChunk
            await gate("rpc"); // held across the tick so that flush fires mid-handler
          },
        },
      },
    };
    const { inst } = await make(def);
    let rendered = false;
    const render = inst.loadForRender({}).then(() => {
      rendered = true;
    });
    const rpc = inst.handleBatch(batch("slow"));
    await tick(); // the rpc's mid-handler flush lands while the loader still awaits
    expect(rendered).toBe(false); // the rpc flush must not open the render gate
    gates.rpc?.();
    await rpc;
    gates.load?.();
    await render;
    expect(rendered).toBe(true);
    expect(inst.state.log).toContain("data");
  });
});

describe("broadcast on-handler isolation (§8)", () => {
  it("a throwing on-handler does not discard an unrelated rpc's pending writes", async () => {
    const def: LiveDefinition<TodoState, "/t/$id", Session> = {
      setup: (ctx) => {
        ctx.subscribe("room:1");
        return initial();
      },
      rpc: {
        slow: {
          async handler(_p, ctx) {
            ctx.patchState(((s) => {
              s.log.push("slow-write");
            }) as Mut);
            gates.slowReady?.();
            await gate("slowRelease");
          },
        },
      },
      on: {
        boom: () => {
          throw new Error("on-handler boom");
        },
      },
    };
    const ready = new Promise<void>((resolve) => {
      gates.slowReady = resolve;
    });
    const { inst, storage } = await make(def);
    const run = inst.handleBatch(batch("slow"));
    // slow's patchState has run and is sitting in the pending list (its flush is
    // a not-yet-fired macrotask); no macrotask boundary has been crossed.
    await ready;
    // A broadcast whose handler throws is delivered while that write is pending.
    storage.bus.publish({
      topic: "room:1",
      event: "boom",
      payload: null,
      senderId: "other",
      self: false,
    });
    await tick();
    gates.slowRelease?.();
    await run;
    await inst.idle();
    // The throwing on-handler must not have discarded slow's unrelated write.
    expect(inst.state.log).toContain("slow-write");
  });
});

describe("cancellation (§3)", () => {
  it("aborts ctx.signal on dispose", async () => {
    let aborted = false;
    const def: LiveDefinition<TodoState, "/t/$id", Session> = {
      setup: () => initial(),
      rpc: {
        watch: {
          async handler(_p, ctx) {
            ctx.signal.addEventListener("abort", () => {
              aborted = true;
            });
            await gate("cancel");
          },
        },
      },
    };
    const { inst } = await make(def);
    const run = inst.handleBatch(batch("watch"));
    await tick();
    await inst.dispose();
    expect(aborted).toBe(true);
    gates.cancel?.();
    await run;
  });

  it("ctx.abort(name) aborts in-flight invocations of a named rpc", async () => {
    let aborted = false;
    const def: LiveDefinition<TodoState, "/t/$id", Session> = {
      setup: () => initial(),
      rpc: {
        ask: {
          async handler(_p, ctx) {
            ctx.signal.addEventListener("abort", () => {
              aborted = true;
            });
            await gate("ask");
          },
        },
        stop: {
          async handler(_p, ctx) {
            ctx.abort("ask");
          },
        },
      },
    };
    const { inst } = await make(def);
    const run = inst.handleBatch(batch("ask"));
    await tick();
    await inst.handleBatch(batch("stop"));
    expect(aborted).toBe(true);
    gates.ask?.();
    await run;
  });
});

describe("validation, rate limiting, onError", () => {
  const def: LiveDefinition<TodoState, "/t/$id", Session> = {
    setup: () => initial(),
    rpc: {
      add: {
        input: z.object({ text: z.string().min(1) }),
        async handler({ text }, ctx) {
          ctx.patchState(((s) => {
            s.todos.push({ id: uid("todo"), text: text as string });
          }) as Mut);
        },
      },
      limited: {
        rateLimit: { capacity: 1, refillPerSec: 0 },
        async handler(_p, ctx) {
          ctx.patchState(((s) => {
            s.log.push("limited");
          }) as Mut);
        },
      },
      explode: {
        async handler() {
          throw new Error("db down");
        },
        onError(state, error) {
          state.lastError = (error as Error).message;
        },
      },
    },
  };

  it("rejects invalid payloads server-side with an error ack", async () => {
    const { inst, envelopes } = await make(def);
    await inst.handleBatch(batch("add", { text: "" }));
    expect(envelopes[0]?.error?.name).toBe("ValidationError");
    expect(inst.state.todos).toHaveLength(0);

    await inst.handleBatch(batch("add", { text: "ok" }));
    expect(inst.state.todos).toHaveLength(1);
  });

  it("enforces per-rpc token buckets", async () => {
    const { inst, envelopes } = await make(def);
    await inst.handleBatch(batch("limited"));
    await inst.handleBatch(batch("limited"));
    expect(inst.state.log).toEqual(["limited"]);
    expect(envelopes[1]?.error?.name).toBe("RateLimitError");
  });

  it("runs onError as a queued mutator riding the error ack", async () => {
    const { inst, envelopes } = await make(def);
    await inst.handleBatch(batch("explode"));
    const ack = envelopes[0] as Envelope;
    expect(ack.error?.message).toBe("db down");
    expect(ack.patches).toEqual([{ op: "add", path: ["lastError"], value: "db down" }]);
    expect(inst.state.lastError).toBe("db down");
  });
});

describe("pubsub (§8)", () => {
  const defFor = (): LiveDefinition<TodoState, "/t/$id", Session> => ({
    setup: (ctx) => {
      ctx.subscribe("room:1");
      return initial();
    },
    rpc: {
      shout: {
        async handler(_p, ctx) {
          ctx.patchState(((s) => {
            s.log.push("sent");
          }) as Mut);
          ctx.broadcast("room:1", "todo.created", { text: "hi" });
        },
      },
      shoutSelf: {
        async handler(_p, ctx) {
          ctx.patchState(((s) => {
            s.log.push("sent");
          }) as Mut);
          ctx.broadcast("room:1", "todo.created", { text: "hi" }, { self: true });
        },
      },
    },
    on: {
      "todo.created": (state, p: { text: string }) => {
        state.log.push(`recv:${p.text}`);
      },
    },
  });

  it("excludes the sender by default, includes it with { self: true }", async () => {
    const storage = memory();
    const a = await make(defFor(), { storage, id: "A" });
    const b = await make(defFor(), { storage, id: "B" });

    await a.inst.handleBatch(batch("shout"));
    await a.inst.idle();
    await b.inst.idle();
    expect(a.inst.state.log).toEqual(["sent"]);
    expect(b.inst.state.log).toEqual(["recv:hi"]);

    await a.inst.handleBatch(batch("shoutSelf"));
    await a.inst.idle();
    expect(a.inst.state.log).toEqual(["sent", "sent", "recv:hi"]);
  });
});

describe("URL loader (§7)", () => {
  // A URL-keyed loader that windows `todos` by filter — the canonical shape.
  const fetchItems = (filter: string, signal?: AbortSignal) =>
    new Promise<{ id: string; text: string }[]>((resolve, reject) => {
      const timer = setTimeout(() => resolve([{ id: `${filter}-1`, text: filter }]), 5);
      signal?.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(new DOMException("aborted", "AbortError"));
      });
    });

  const def: LiveDefinition<TodoState, "/t/$id", Session> = {
    setup: () => initial(),
    load: async ({ search }, ctx) => {
      const f = search.filter ?? "all";
      ctx.patchState((s) => {
        s.filter = f;
        s.loading = true;
      });
      const items = await fetchItems(f, ctx.signal);
      ctx.patchState((s) => {
        s.todos = items;
        s.loading = false;
      });
    },
  };

  it("writes page state (not the $session slice) and fires the loader", async () => {
    const { inst, envelopes } = await make(def);
    await inst.load({ filter: "done" });
    expect(inst.state.filter).toBe("done");
    expect(inst.state.todos).toEqual([{ id: "done-1", text: "done" }]);
    expect(inst.state.loading).toBe(false);
    // Patches target page state, never the $session namespace.
    const paths = envelopes.flatMap((e) => e.patches?.map((p) => p.path[0]) ?? []);
    expect(paths).not.toContain("$session");
    expect(paths).toContain("filter");
  });

  it("keeps the previous window visible while loading (keepPreviousData)", async () => {
    const { inst } = await make(def);
    await inst.load({ filter: "open" });
    const load2 = inst.load({ filter: "done" });
    // Synchronous projection landed; old items still present mid-load.
    await tick();
    expect(inst.state.filter).toBe("done");
    expect(inst.state.loading).toBe(true);
    expect(inst.state.todos).toEqual([{ id: "open-1", text: "open" }]);
    await load2;
    expect(inst.state.todos).toEqual([{ id: "done-1", text: "done" }]);
  });

  it("is latest-wins: a superseded run's late flush is dropped", async () => {
    const { inst } = await make(def);
    const a = inst.load({ filter: "a" });
    const b = inst.load({ filter: "b" });
    await Promise.all([a, b]);
    await inst.idle();
    // Only the last URL's window lands, regardless of resolution order.
    expect(inst.state.filter).toBe("b");
    expect(inst.state.todos).toEqual([{ id: "b-1", text: "b" }]);
  });

  it("aborts the prior loader's signal when superseded", async () => {
    let aborted = false;
    const spyDef: LiveDefinition<TodoState, "/t/$id", Session> = {
      setup: () => initial(),
      load: async ({ search }, ctx) => {
        ctx.signal.addEventListener("abort", () => {
          aborted = true;
        });
        await fetchItems(search.filter ?? "all", ctx.signal).catch(() => {});
      },
    };
    const { inst } = await make(spyDef);
    void inst.load({ filter: "a" });
    await inst.load({ filter: "b" });
    expect(aborted).toBe(true);
  });

  it("does not throw when the loader rejects; error is userland state", async () => {
    const boomDef: LiveDefinition<TodoState, "/t/$id", Session> = {
      setup: () => initial(),
      load: async (_url, ctx) => {
        ctx.patchState((s) => {
          s.loading = true;
        });
        try {
          throw new Error("db down");
        } catch {
          ctx.patchState((s) => {
            s.loading = false;
            s.loadError = "db down";
          });
        }
      },
    };
    const { inst } = await make(boomDef);
    await expect(inst.load({ filter: "x" })).resolves.toBeUndefined();
    expect(inst.state.loadError).toBe("db down");
    expect(inst.state.loading).toBe(false);
  });

  it("re-throws a redirect from the loader for the caller to map (§10)", async () => {
    const gated: LiveDefinition<TodoState, "/t/$id", Session> = {
      setup: () => initial(),
      load: async () => {
        throw redirect("/login");
      },
    };
    const { inst } = await make(gated);
    await expect(inst.load({ filter: "x" })).rejects.toMatchObject({
      $redirect: true,
      location: "/login",
    });
  });

  it("a superseded run's redirect does not fire — only the current run redirects (§10)", async () => {
    let release: () => void = () => {};
    const gated: LiveDefinition<TodoState, "/t/$id", Session> = {
      setup: () => initial(),
      load: async ({ search }) => {
        if (search.filter === "stale") {
          await new Promise<void>((r) => {
            release = r;
          });
          throw redirect("/should-not-happen");
        }
      },
    };
    const { inst } = await make(gated);
    const stale = inst.load({ filter: "stale" }); // will be superseded mid-flight
    await tick();
    await inst.load({ filter: "fresh" }); // claims the run tag
    release(); // the stale run now throws redirect — but it's no longer current
    await expect(stale).resolves.toBeUndefined();
  });

  it("receives typed path params alongside search in the url arg", async () => {
    let seen: { params: { id: string }; search: Record<string, string | undefined> } | undefined;
    const spy: LiveDefinition<TodoState, "/t/$id", Session> = {
      setup: () => initial(),
      load: async (url) => {
        seen = url as typeof seen;
      },
    };
    const { inst } = await make(spy);
    await inst.load({ filter: "x" });
    expect(seen?.params).toEqual({ id: "42" });
    expect(seen?.search).toEqual({ filter: "x" });
  });

  it("cold wake re-runs setup; the window rebuilds from the URL via load (§9)", async () => {
    const storage = memory();
    let setups = 0;
    const counting: LiveDefinition<TodoState, "/t/$id", Session> = {
      ...def,
      setup: () => {
        setups += 1;
        return initial();
      },
    };
    const first = await make(counting, { storage, key: "k1" });
    await first.inst.load({ filter: "done" });
    const seqBefore = first.inst.seq;
    await first.inst.dispose();

    // Cold wake: setup re-runs (page state fresh), then the client re-presents
    // the URL — load rebuilds the same window.
    const second = await make(counting, { storage, key: "k1" });
    expect(setups).toBe(2);
    expect(second.inst.seq).toBeGreaterThan(seqBefore);
    await second.inst.load({ filter: "done" });
    expect(second.inst.state.todos).toEqual([{ id: "done-1", text: "done" }]);
  });
});

describe("guard / authorize (§10)", () => {
  it("authorize runs the guard; a deny throws redirect", async () => {
    const def: LiveDefinition<TodoState, "/t/$id", Session> = {
      setup: () => initial(),
      guard: async ({ search }) => {
        if (search.filter === "secret") throw redirect("/403");
      },
    };
    const { inst } = await make(def);
    await expect(inst.authorize({ filter: "ok" })).resolves.toBeUndefined();
    await expect(inst.authorize({ filter: "secret" })).rejects.toMatchObject({ location: "/403" });
  });

  it("re-checks on every URL change (search too), catching a spoofed param", async () => {
    const def: LiveDefinition<TodoState, "/t/$id", Session> = {
      setup: () => initial(),
      guard: async ({ search }) => {
        if (search.userId && search.userId !== "me") throw redirect("/403");
      },
    };
    const { inst } = await make(def);
    await expect(inst.authorize({ userId: "me" })).resolves.toBeUndefined();
    await expect(inst.authorize({ userId: "other" })).rejects.toMatchObject({ location: "/403" });
  });

  it("is a no-op when no guard is declared", async () => {
    const { inst } = await make(baseDef);
    await expect(inst.authorize({ anything: "x" })).resolves.toBeUndefined();
  });

  it("gets the typed url + signal; a newer call aborts the prior guard", async () => {
    let seen: { params: { id: string }; search: SearchParams; signal: boolean } | undefined;
    let firstAborted = false;
    let release: () => void = () => {};
    const def: LiveDefinition<TodoState, "/t/$id", Session> = {
      setup: () => initial(),
      guard: async (url, ctx) => {
        seen = {
          params: url.params,
          search: url.search,
          signal: ctx.signal instanceof AbortSignal,
        };
        if (url.search.slow) {
          ctx.signal.addEventListener("abort", () => {
            firstAborted = true;
          });
          await new Promise<void>((r) => {
            release = r;
          });
        }
      },
    };
    const { inst } = await make(def);
    const slow = inst.authorize({ slow: "1" });
    await tick();
    await inst.authorize({ q: "x" }); // newer call aborts the slow guard's signal
    expect(firstAborted).toBe(true);
    release();
    await slow.catch(() => {});
    expect(seen).toEqual({ params: { id: "42" }, search: { q: "x" }, signal: true });
  });

  it("surfaces a superseded guard's throw as SupersededError (never the guard's own error)", async () => {
    let release: () => void = () => {};
    const def: LiveDefinition<TodoState, "/t/$id", Session> = {
      setup: () => initial(),
      guard: async (url, ctx) => {
        if (url.search.slow) {
          await new Promise<void>((r) => {
            release = r;
          });
          // A guard that respects the signal throws once aborted.
          if (ctx.signal.aborted) throw new DOMException("aborted", "AbortError");
        }
      },
    };
    const { inst } = await make(def);
    const slow = inst.authorize({ slow: "1" });
    await tick();
    await inst.authorize({ q: "x" }); // newer call aborts the slow guard
    release();
    // The superseded run rejects with the supersession marker — never its own
    // AbortError (a spurious 500), and never a resolve (a spurious allow).
    await expect(slow).rejects.toSatisfy(isSuperseded);
  });

  it("a superseded deny rejects with SupersededError — the caller never loads the denied URL", async () => {
    let release: () => void = () => {};
    const loaded: string[] = [];
    const def: LiveDefinition<TodoState, "/t/$id", Session> = {
      setup: () => initial(),
      guard: async ({ search }) => {
        if (search.userId && search.userId !== "me") {
          await new Promise<void>((r) => {
            release = r;
          });
          throw redirect("/403"); // slow deny — superseded mid-flight
        }
      },
      load: async ({ search }, ctx) => {
        loaded.push(search.userId ?? search.q ?? "?");
        ctx.patchState(((s) => {
          s.filter = search.userId ?? search.q;
        }) as Mut);
      },
    };
    const { inst } = await make(def);
    // The transport's reconcile shape: authorize, then load only on an allow.
    const stale = inst
      .authorize({ userId: "other" })
      .then(() => inst.load({ userId: "other" }))
      .then(
        () => undefined,
        (e: unknown) => e,
      );
    await tick();
    await inst.authorize({ q: "x" }); // newer URL supersedes the pending deny
    release(); // the denied guard now throws — into a superseded run
    // The stale run must not resolve into an allow: it rejects with the marker
    // and the denied URL's loader never runs (the spoofed-?userId leak, §10).
    expect(isSuperseded(await stale)).toBe(true);
    expect(loaded).not.toContain("other");
    await inst.idle();
  });

  it("an allow from a superseded run is stale too — rejects with SupersededError", async () => {
    let release: () => void = () => {};
    const def: LiveDefinition<TodoState, "/t/$id", Session> = {
      setup: () => initial(),
      guard: async ({ search }) => {
        if (search.slow) {
          await new Promise<void>((r) => {
            release = r;
          });
          // resolves — an allow, but for a URL a newer call replaced
        }
      },
    };
    const { inst } = await make(def);
    const slow = inst.authorize({ slow: "1" });
    await tick();
    await inst.authorize({ q: "x" });
    release();
    await expect(slow).rejects.toSatisfy(isSuperseded);
  });
});

describe("id linking escape hatch (§4)", () => {
  it("sends ctx.resolveId mappings in the ack idMap", async () => {
    const def: LiveDefinition<TodoState, "/t/$id", Session> = {
      setup: () => initial(),
      rpc: {
        create: {
          async handler({ tempId }: { tempId: string }, ctx) {
            ctx.patchState(((s) => {
              s.todos.push({ id: "real-9", text: "x" });
            }) as Mut);
            ctx.resolveId(tempId as string, "real-9");
          },
        },
      },
    };
    const { inst, envelopes } = await make(def);
    await inst.handleBatch(batch("create", { tempId: "tmp-1" }));
    expect(envelopes[0]?.idMap).toEqual({ "tmp-1": "real-9" });
  });
});

describe("protocol version check (W1)", () => {
  it("rejects a batch whose version doesn't match with a ProtocolError ack, state untouched", async () => {
    const { inst, envelopes } = await make(baseDef);
    const before = structuredClone(inst.state);

    await inst.handleBatch({
      v: (PROTOCOL_VERSION + 1) as typeof PROTOCOL_VERSION,
      instance: "i",
      rpcId: "v2-batch",
      calls: [{ rpc: "add", payload: { text: "should not run" } }],
    });

    const ack = envelopes.find((e) => e.rpcId === "v2-batch");
    expect(ack).toBeDefined();
    expect(ack?.error?.name).toBe("ProtocolError");
    expect(ack?.error?.message).toContain(`server: v${PROTOCOL_VERSION}`);
    // The handler never ran — confirmed state is exactly what it was.
    expect(inst.state).toEqual(before);
    expect(inst.state.todos).toHaveLength(0);
  });

  it("still acks a matching-version batch normally (regression)", async () => {
    const { inst, envelopes } = await make(baseDef);
    await inst.handleBatch(batch("add", { text: "milk" }, "v1-batch"));
    const ack = envelopes.find((e) => e.rpcId === "v1-batch");
    expect(ack?.error).toBeUndefined();
    expect(inst.state.todos).toHaveLength(1);
  });
});

describe("event sink (#73)", () => {
  it("emits a structured instance/load-failed event to an injected sink", async () => {
    const events: RpxdEvent[] = [];
    const boom = new Error("loader exploded");
    const def: LiveDefinition<TodoState, "/t/$id", Session> = {
      setup: () => initial(),
      load: async () => {
        throw boom;
      },
    };
    const { inst } = await make(def, { emit: (e) => events.push(e) });
    await inst.loadForRender({});
    const failed = events.find((e) => e.type === "load-failed");
    expect(failed).toMatchObject({ category: "instance", level: "error", error: boom });
  });

  it("emits a storage/subscriber-threw event when a broadcast subscriber throws", async () => {
    const events: RpxdEvent[] = [];
    const storage = memory();
    storage.bus.setEmit?.((e) => events.push(e));
    storage.bus.subscribe("room:1", "sub-a", () => {
      throw new Error("subscriber exploded");
    });
    storage.bus.publish({
      topic: "room:1",
      event: "hi",
      payload: {},
      senderId: "sub-b",
      self: false,
    });
    const threw = events.find((e) => e.type === "subscriber-threw");
    expect(threw).toMatchObject({ category: "storage", level: "error" });
    expect(threw?.detail).toMatchObject({ topic: "room:1", subscriberId: "sub-a" });
  });

  it("falls back to defaultEventSink (console) when no sink is injected", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const def: LiveDefinition<TodoState, "/t/$id", Session> = {
        setup: () => initial(),
        load: async () => {
          throw new Error("no sink here");
        },
      };
      const { inst } = await make(def); // no emit injected
      await expect(inst.loadForRender({})).resolves.toBeUndefined();
      expect(spy).toHaveBeenCalledWith(
        expect.stringContaining("instance/load-failed"),
        expect.anything(),
      );
    } finally {
      spy.mockRestore();
    }
  });

  it("swallows a throwing sink so observability can't break the load path", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const def: LiveDefinition<TodoState, "/t/$id", Session> = {
        setup: () => initial(),
        load: async () => {
          throw new Error("loader failed");
        },
      };
      const { inst } = await make(def, {
        emit: () => {
          throw new Error("sink blew up");
        },
      });
      // The throwing sink must not propagate out of the load path.
      await expect(inst.loadForRender({})).resolves.toBeUndefined();
      expect(spy).toHaveBeenCalled(); // the sink throw was caught + reported
    } finally {
      spy.mockRestore();
    }
  });
});
