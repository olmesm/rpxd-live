import { describe, expect, it } from "vitest";
import { z } from "zod";
import { LiveInstance } from "../src/instance.ts";
import { redirect } from "../src/redirect.ts";
import type { LiveDefinition, Mutator, SearchParams } from "../src/live.ts";
import { type Envelope, PROTOCOL_VERSION, type RpcBatch } from "../src/protocol.ts";
import { memory, type StorageAdapter } from "../src/storage.ts";

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

describe("atomic rpcs (§3)", () => {
  const def: LiveDefinition<TodoState, "/t/$id", Session> = {
    setup: () => initial(),
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

  it("swallows a superseded guard's throw (a signal-respecting AbortError never propagates)", async () => {
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
    // The superseded run's AbortError must be swallowed, not propagated.
    await expect(slow).resolves.toBeUndefined();
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
