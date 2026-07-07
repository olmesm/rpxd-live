import type { Draft } from "immer";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { LiveInstance } from "../src/instance.ts";
import type { LiveDefinition, RpcCtx } from "../src/live.ts";
import { type Envelope, PROTOCOL_VERSION, type RpcBatch } from "../src/protocol.ts";
import { memory, type StorageAdapter } from "../src/storage.ts";

interface TodoState {
  todos: { id: string; text: string }[];
  log: string[];
  importing?: boolean;
  lastError?: string;
}

type Session = { filter?: string };
type St = Draft<TodoState>;
type Get = () => Draft<TodoState>;
type Ctx = RpcCtx<{ id: string }, Session>;

let nextId = 0;
const uid = (prefix: string) => `${prefix}-${++nextId}`;

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

const baseDef: LiveDefinition<TodoState, "/t/$id", Session> = {
  mount: async () => ({ todos: [], log: [] }),
  rpc: {
    async add(state: St, { text }: { text: string }) {
      state.todos.push({ id: uid("todo"), text });
    },
    async fast(state: St) {
      state.log.push("fast");
    },
  },
};

describe("LiveInstance basics", () => {
  it("mounts with a full-snapshot seq and acks a plain rpc with combined patches", async () => {
    const { inst, envelopes } = await make(baseDef);
    expect(inst.seq).toBe(1); // mount emitted the initial full envelope

    await inst.handleBatch(batch("add", { text: "milk" }));
    expect(inst.state.todos).toHaveLength(1);
    expect(envelopes).toHaveLength(1);
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

describe("validation and rate limiting", () => {
  const def: LiveDefinition<TodoState, "/t/$id", Session> = {
    mount: async () => ({ todos: [], log: [] }),
    rpc: {
      add: {
        input: z.object({ text: z.string().min(1) }),
        async handler(state: St, { text }: { text: string }) {
          state.todos.push({ id: uid("todo"), text });
        },
      },
      limited: {
        rateLimit: { capacity: 1, refillPerSec: 0 },
        async handler(state: St) {
          state.log.push("limited");
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
});

describe("onError (§5)", () => {
  it("runs as a queued reducer on handler throw and rides the error ack", async () => {
    const def: LiveDefinition<TodoState, "/t/$id", Session> = {
      mount: async () => ({ todos: [], log: [] }),
      rpc: {
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
    const { inst, envelopes } = await make(def);
    await inst.handleBatch(batch("explode"));
    const ack = envelopes[0] as Envelope;
    expect(ack.error?.message).toBe("db down");
    expect(ack.patches).toEqual([{ op: "add", path: ["lastError"], value: "db down" }]);
    expect(inst.state.lastError).toBe("db down");
  });
});

describe("generator rpcs (§3)", () => {
  const gates: Record<string, () => void> = {};
  const gate = (name: string) =>
    new Promise<void>((resolve) => {
      gates[name] = resolve;
    });

  it("flushes one envelope per segment and releases the queue at yield", async () => {
    const def: LiveDefinition<TodoState, "/t/$id", Session> = {
      mount: async () => ({ todos: [], log: [] }),
      rpc: {
        ...baseDef.rpc,
        async *stream(getState: Get) {
          getState().log.push("g1");
          yield;
          getState().log.push("g2");
        },
      },
    };
    const { inst, envelopes } = await make(def);

    // When the first segment's envelope lands, race a plain rpc in — it must
    // run between segments because the queue releases at yield.
    let injected = false;
    let fastDone: Promise<void> | undefined;
    inst.addListener(() => {
      if (!injected) {
        injected = true;
        fastDone = inst.handleBatch(batch("fast"));
      }
    });

    await inst.handleBatch(batch("stream"));
    await fastDone;
    expect(inst.state.log).toEqual(["g1", "fast", "g2"]);
    // stream seg1, fast ack, stream seg2, stream ack
    expect(envelopes.length).toBe(4);
    expect(envelopes[3]?.rpcId).toBeDefined();
    expect(envelopes[3]?.patches).toEqual([]);
  });

  it("zero-yield early return behaves like a plain async reducer", async () => {
    const def: LiveDefinition<TodoState, "/t/$id", Session> = {
      mount: async () => ({ todos: [], log: [] }),
      rpc: {
        // biome-ignore lint/correctness/useYield: zero-yield return ≡ plain async reducer (spec §3)
        async *maybe(getState: Get, { skip }: { skip: boolean }) {
          if (skip) {
            getState().log.push("skipped");
            return;
          }
          getState().log.push("ran");
        },
      },
    };
    const { inst, envelopes } = await make(def);
    await inst.handleBatch(batch("maybe", { skip: true }));
    expect(inst.state.log).toEqual(["skipped"]);
    expect(envelopes).toHaveLength(2); // final segment flush + ack
  });

  it("runs finally blocks on cancellation (disconnect mid-run)", async () => {
    const def: LiveDefinition<TodoState, "/t/$id", Session> = {
      mount: async () => ({ todos: [], log: [] }),
      rpc: {
        async *importCsv(getState: Get) {
          try {
            getState().importing = true;
            yield;
            await gate("import");
            getState().log.push("unreachable-after-cancel?");
            yield;
            await gate("never");
          } finally {
            getState().importing = false;
          }
        },
      },
    };
    const { inst } = await make(def);
    const run = inst.handleBatch(batch("importCsv"));
    // Wait until the first segment flushed (importing: true committed).
    await new Promise<void>((resolve) => {
      const check = () => (inst.state.importing ? resolve() : setTimeout(check, 1));
      check();
    });
    const disposal = inst.dispose();
    gates.import?.(); // let the in-flight segment settle so cancel can run
    await disposal;
    await run;
    expect(inst.state.importing).toBe(false); // finally ran even on disconnect
  });

  it("surfaces mid-generator throws via error ack, keeping flushed segments", async () => {
    const def: LiveDefinition<TodoState, "/t/$id", Session> = {
      mount: async () => ({ todos: [], log: [] }),
      rpc: {
        crashy: {
          async *handler(getState: Get) {
            getState().importing = true;
            yield;
            throw new Error("mid-stream");
          },
          onError(state) {
            state.importing = false;
            state.lastError = "Import failed";
          },
        },
      },
    };
    const { inst, envelopes } = await make(def);
    await inst.handleBatch(batch("crashy"));
    expect(inst.state.importing).toBe(false);
    expect(inst.state.lastError).toBe("Import failed");
    const ack = envelopes.at(-1) as Envelope;
    expect(ack.error?.message).toBe("mid-stream");
    expect(ack.patches?.length).toBeGreaterThan(0); // onError repairs ride the ack
  });

  it("rejects holding getState() across an interleaved commit boundary", async () => {
    const def: LiveDefinition<TodoState, "/t/$id", Session> = {
      mount: async () => ({ todos: [], log: [] }),
      rpc: {
        async *leaky(getState: Get) {
          const held = getState();
          yield;
          held.log.push("stale"); // draft finalized at yield → immer throws
        },
      },
    };
    const { inst, envelopes } = await make(def);
    await inst.handleBatch(batch("leaky"));
    expect(envelopes.at(-1)?.error).toBeDefined();
  });
});

describe("pubsub (§8)", () => {
  const defFor = (): LiveDefinition<TodoState, "/t/$id", Session> => ({
    mount: async (_params, ctx) => {
      ctx.subscribe("room:1");
      return { todos: [], log: [] };
    },
    rpc: {
      async shout(state: St, _p: unknown, ctx: Ctx) {
        state.log.push("sent");
        ctx.broadcast("room:1", "todo.created", { text: "hi" });
      },
      async shoutSelf(state: St, _p: unknown, ctx: Ctx) {
        state.log.push("sent");
        ctx.broadcast("room:1", "todo.created", { text: "hi" }, { self: true });
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
    expect(a.inst.state.log).toEqual(["sent"]); // no self-delivery
    expect(b.inst.state.log).toEqual(["recv:hi"]);
    expect(b.envelopes.some((e) => e.patches && !e.rpcId)).toBe(true); // broadcast envelope

    await a.inst.handleBatch(batch("shoutSelf"));
    await a.inst.idle();
    expect(a.inst.state.log).toEqual(["sent", "sent", "recv:hi"]);
  });
});

describe("session slice (§7) and snapshots (§9)", () => {
  const def: LiveDefinition<TodoState, "/t/$id", Session> = {
    mount: async () => ({ todos: [], log: [] }),
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
        return { todos: [], log: [] };
      },
    };
    const first = await make(counting, { storage, key: "k1" });
    await first.inst.setSearch({ filter: "done" });
    const seqBefore = first.inst.seq;
    await first.inst.dispose();

    const second = await make(counting, { storage, key: "k1" });
    expect(mounts).toBe(2); // cold wake re-ran mount
    expect(second.inst.session.filter).toBe("done"); // session survived
    expect(second.inst.seq).toBeGreaterThan(seqBefore); // seq continues
  });

  it("discards snapshots on version mismatch", async () => {
    const storage = memory();
    const v1 = { ...def, version: "v1" };
    const first = await make(v1, { storage, key: "k2" });
    await first.inst.setSearch({ filter: "done" });
    await first.inst.dispose();

    const v2 = { ...def, version: "v2" };
    const second = await make(v2, { storage, key: "k2" });
    expect(second.inst.session.filter).toBeUndefined();
  });
});

describe("id linking escape hatch (§4)", () => {
  it("sends ctx.resolveId mappings in the ack idMap", async () => {
    const def: LiveDefinition<TodoState, "/t/$id", Session> = {
      mount: async () => ({ todos: [], log: [] }),
      rpc: {
        async create(state: St, { tempId }: { tempId: string }, ctx: Ctx) {
          state.todos.push({ id: "real-9", text: "x" });
          ctx.resolveId(tempId, "real-9");
        },
      },
    };
    const { inst, envelopes } = await make(def);
    await inst.handleBatch(batch("create", { tempId: "tmp-1" }));
    expect(envelopes[0]?.idMap).toEqual({ "tmp-1": "real-9" });
  });
});
