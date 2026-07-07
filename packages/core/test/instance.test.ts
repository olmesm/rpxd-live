import { describe, expect, it } from "vitest";
import { z } from "zod";
import { LiveInstance } from "../src/instance.ts";
import type { LiveDefinition, Mutator } from "../src/live.ts";
import { type Envelope, PROTOCOL_VERSION, type RpcBatch } from "../src/protocol.ts";
import { memory, type StorageAdapter } from "../src/storage.ts";

interface TodoState {
  todos: { id: string; text: string }[];
  log: string[];
  answer: string;
  importing?: boolean;
  lastError?: string;
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
  opts: { storage?: StorageAdapter; key?: string; session?: Session; id?: string } = {},
) {
  const storage = opts.storage ?? memory();
  const inst = await LiveInstance.create({
    id: opts.id ?? uid("inst"),
    def,
    params: { id: "42" },
    session: opts.session ?? {},
    storage,
    storageKey: opts.key ?? uid("key"),
  });
  const envelopes: Envelope[] = [];
  inst.addListener((env) => envelopes.push(env));
  return { inst, envelopes, storage };
}

const initial = (): TodoState => ({ todos: [], log: [], answer: "" });

const baseDef: LiveDefinition<TodoState, "/t/$id", Session> = {
  mount: async () => initial(),
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
    expect(inst.seq).toBe(1); // mount emitted the initial full envelope

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

describe("concurrency (§3): handlers never block the instance", () => {
  it("runs a fast rpc while a slow handler awaits", async () => {
    const def: LiveDefinition<TodoState, "/t/$id", Session> = {
      mount: async () => initial(),
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
      mount: async () => initial(),
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
      mount: async () => initial(),
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
      mount: async () => initial(),
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
      mount: async () => initial(),
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

describe("atomic rpcs (§3)", () => {
  const def: LiveDefinition<TodoState, "/t/$id", Session> = {
    mount: async () => initial(),
    rpc: {
      transfer: {
        atomic: true,
        async handler({ boom }: { boom?: boolean }, ctx) {
          ctx.patchState(((s) => {
            s.log.push("step1");
          }) as Mut);
          await tick(); // would flush in non-atomic mode
          ctx.patchState(((s) => {
            s.log.push("step2");
          }) as Mut);
          if (boom) throw new Error("mid-transfer");
        },
      },
    },
  };

  it("buffers all patches into one flush at completion", async () => {
    const { inst, envelopes } = await make(def);
    await inst.handleBatch(batch("transfer", {}));
    expect(envelopes).toHaveLength(1);
    expect(envelopes[0]?.patches).toHaveLength(2);
    expect(envelopes[0]?.rpcId).toBeDefined();
  });

  it("discards everything on throw — whole-rpc rollback", async () => {
    const { inst, envelopes } = await make(def);
    await inst.handleBatch(batch("transfer", { boom: true }));
    expect(inst.state.log).toEqual([]); // nothing landed
    const ack = envelopes[0] as Envelope;
    expect(ack.error?.message).toBe("mid-transfer");
    expect(ack.patches ?? []).toHaveLength(0);
  });
});

describe("cancellation (§3)", () => {
  it("aborts ctx.signal on dispose", async () => {
    let aborted = false;
    const def: LiveDefinition<TodoState, "/t/$id", Session> = {
      mount: async () => initial(),
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
      mount: async () => initial(),
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
    mount: async () => initial(),
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
    mount: async (_params, ctx) => {
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

describe("session slice (§7) and snapshots (§9)", () => {
  const def: LiveDefinition<TodoState, "/t/$id", Session> = {
    mount: async () => initial(),
    params: (session, { filter }) => {
      session.filter = filter ?? "all";
    },
  };

  it("routes params-reducer patches through the $session namespace", async () => {
    const { inst, envelopes } = await make(def);
    await inst.setSearch({ filter: "done" });
    expect(inst.session.filter).toBe("done");
    expect(envelopes[0]?.patches?.[0]?.path).toEqual(["$session", "filter"]);
  });

  it("write-through snapshots restore session continuity; mount re-runs on cold wake", async () => {
    const storage = memory();
    let mounts = 0;
    const counting: LiveDefinition<TodoState, "/t/$id", Session> = {
      ...def,
      mount: async () => {
        mounts += 1;
        return initial();
      },
    };
    const first = await make(counting, { storage, key: "k1" });
    await first.inst.setSearch({ filter: "done" });
    const seqBefore = first.inst.seq;
    await first.inst.dispose();

    const second = await make(counting, { storage, key: "k1" });
    expect(mounts).toBe(2);
    expect(second.inst.session.filter).toBe("done");
    expect(second.inst.seq).toBeGreaterThan(seqBefore);
  });
});

describe("id linking escape hatch (§4)", () => {
  it("sends ctx.resolveId mappings in the ack idMap", async () => {
    const def: LiveDefinition<TodoState, "/t/$id", Session> = {
      mount: async () => initial(),
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
