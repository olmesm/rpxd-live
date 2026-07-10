import {
  type Envelope,
  type LiveDefinition,
  LiveInstance,
  memory,
  PROTOCOL_VERSION,
  type RpcBatch,
} from "@rpxd/core";
import { describe, expect, it } from "vitest";
import { LiveStore, type RpcMeta, rpcMetaFromDef } from "../src/store.ts";

interface Todo {
  id: string;
  text: string;
}
interface State {
  todos: Todo[];
  other: { untouched: true };
}

const initial: State = { todos: [{ id: "t1", text: "existing" }], other: { untouched: true } };

const flushTick = () => new Promise<void>((r) => setTimeout(r, 0));

function makeStore(meta: Record<string, RpcMeta> = {}) {
  const sent: RpcBatch[] = [];
  const resyncs: number[] = [];
  const store = new LiveStore<State>({
    instance: "i1",
    meta,
    send: (b) => sent.push(b),
    requestResync: (seq) => resyncs.push(seq),
  });
  store.applyEnvelope({
    seq: 1,
    instance: "i1",
    full: { state: structuredClone(initial), session: { filter: "all" } },
  });
  return { store, sent, resyncs };
}

const addMeta: Record<string, RpcMeta> = {
  add: {
    optimistic: (state: State, { text }: { text: string }, ctx) => {
      state.todos.push({ id: ctx.tempId(), text });
    },
  },
  rename: {
    optimistic: (state: State, { id, text }: { id: string; text: string }) => {
      const todo = state.todos.find((t) => t.id === id);
      if (!todo) throw new Error("gone");
      todo.text = text;
    },
  },
};

describe("batching (§6)", () => {
  it("coalesces same-tick calls into one batch", async () => {
    const { store, sent } = makeStore();
    const p1 = store.call("a", { n: 1 });
    const p2 = store.call("b", { n: 2 });
    await flushTick();
    expect(sent).toHaveLength(1);
    expect(sent[0]?.calls.map((c) => c.rpc)).toEqual(["a", "b"]);

    // ack settles both
    store.applyEnvelope({ seq: 2, instance: "i1", patches: [], rpcId: sent[0]?.rpcId });
    await expect(p1).resolves.toBeUndefined();
    await expect(p2).resolves.toBeUndefined();
  });

  it("separate ticks produce separate batches", async () => {
    const { store, sent } = makeStore();
    void store.call("a");
    await flushTick();
    void store.call("b");
    await flushTick();
    expect(sent).toHaveLength(2);
  });
});

describe("optimistic replay (§4)", () => {
  it("shows optimistic view immediately; confirmed stays server truth", async () => {
    const { store, sent } = makeStore(addMeta);
    void store.call("add", { text: "new" }).catch(() => {});
    await flushTick();

    expect(store.snapshot().state.todos).toHaveLength(2);
    expect(store.confirmed.todos).toHaveLength(1);
    expect(store.snapshot().sync.pending).toBe(true);

    // ack applies the real patch and drops the fn
    store.applyEnvelope({
      seq: 2,
      instance: "i1",
      rpcId: sent[0]?.rpcId,
      patches: [{ op: "add", path: ["todos", 1], value: { id: "real-2", text: "new" } }],
    });
    const after = store.snapshot();
    expect(after.state.todos).toHaveLength(2);
    expect(after.state.todos[1]?.id).toBe("real-2");
    expect(after.sync.pending).toBe(false);
  });

  it("rolls back for free on error ack and surfaces sync.errors", async () => {
    const { store, sent } = makeStore(addMeta);
    const p = store.call("add", { text: "doomed" });
    await flushTick();
    expect(store.snapshot().state.todos).toHaveLength(2);

    store.applyEnvelope({
      seq: 2,
      instance: "i1",
      rpcId: sent[0]?.rpcId,
      patches: [],
      error: { name: "Error", message: "db down", rpc: "add" },
    });
    await expect(p).rejects.toThrow("db down");
    expect(store.snapshot().state.todos).toHaveLength(1); // rollback = replay minus fn
    expect(store.snapshot().sync.errors[0]?.message).toBe("db down");
  });

  it("drops a throwing replay silently", async () => {
    const { store } = makeStore(addMeta);
    void store.call("rename", { id: "nope", text: "x" }).catch(() => {});
    await flushTick();
    // optimistic fn throws (row missing) → dropped, view = confirmed
    expect(store.snapshot().state.todos).toEqual(initial.todos);
    expect(store.snapshot().sync.errors).toHaveLength(0);
  });

  it("preserves structural sharing off the patch path", () => {
    const { store } = makeStore();
    const before = store.snapshot().state.other;
    store.applyEnvelope({
      seq: 2,
      instance: "i1",
      patches: [{ op: "replace", path: ["todos", 0, "text"], value: "renamed" }],
    });
    expect(store.snapshot().state.other).toBe(before); // untouched branch keeps identity
  });
});

describe("id linking + keyOf (§4)", () => {
  it("position-matches tempIds to real ids and keeps keys stable", async () => {
    const { store, sent } = makeStore(addMeta);
    void store.call("add", { text: "linked" });
    await flushTick();

    const tempId = store.snapshot().state.todos[1]?.id as string;
    expect(tempId).toMatch(/^__rpxd_tmp_/);
    expect(store.keyOf(tempId)).toBe(tempId);

    store.applyEnvelope({
      seq: 2,
      instance: "i1",
      rpcId: sent[0]?.rpcId,
      patches: [{ op: "add", path: ["todos", 1], value: { id: "real-77", text: "linked" } }],
    });
    // real id renders under the original tempId key → no remount
    expect(store.keyOf("real-77")).toBe(tempId);
    expect(store.keyOf("t1")).toBe("t1");
  });

  it("honours the server idMap escape hatch", async () => {
    const { store, sent } = makeStore(addMeta);
    void store.call("add", { text: "x" });
    await flushTick();
    const tempId = store.snapshot().state.todos[1]?.id as string;

    store.applyEnvelope({
      seq: 2,
      instance: "i1",
      rpcId: sent[0]?.rpcId,
      patches: [],
      idMap: { [tempId]: "real-88" },
    });
    expect(store.keyOf("real-88")).toBe(tempId);
  });
});

describe("malformed frame robustness (§2)", () => {
  it("does not throw or wedge the pending rpc on a corrupt in-order frame", async () => {
    const { store, sent, resyncs } = makeStore(addMeta);
    const p = store.call("add", { text: "x" });
    await flushTick();
    const rpcId = sent.at(-1)?.rpcId;
    expect(rpcId).toBeDefined();

    // A corrupt in-order frame (patches present but not iterable) for the
    // pending rpc — a hostile/buggy server must not throw into the transport
    // or leave the rpc promise hanging forever.
    expect(() =>
      store.applyEnvelope({
        seq: 2,
        instance: "i1",
        rpcId,
        // biome-ignore lint/suspicious/noExplicitAny: intentionally malformed wire frame
        patches: { length: 1 } as any,
      }),
    ).not.toThrow();
    expect(resyncs.length).toBeGreaterThan(0); // recovered via resync
    await expect(p).resolves.toBeUndefined(); // settled, not wedged
  });

  it("settles the rpc even when the corrupt frame reaches id linking (tempIds issued)", async () => {
    const { store, sent, resyncs } = makeStore(addMeta);
    const p = store.call("add", { text: "x" });
    await flushTick();
    // Rendering populates tempIds + lastPatches — the id-linking inputs.
    expect(store.snapshot().state.todos[1]?.id).toMatch(/^__rpxd_tmp_/);

    expect(() =>
      store.applyEnvelope({
        seq: 2,
        instance: "i1",
        rpcId: sent.at(-1)?.rpcId,
        // biome-ignore lint/suspicious/noExplicitAny: intentionally malformed wire frame
        patches: { length: 1 } as any,
      }),
    ).not.toThrow();
    expect(resyncs.length).toBeGreaterThan(0); // recovered via resync
    await expect(p).resolves.toBeUndefined(); // settled, not wedged
  });

  it("settles a stale ack whose patches are corrupt (tempIds issued)", async () => {
    const { store, sent } = makeStore(addMeta);
    const p = store.call("add", { text: "x" });
    await flushTick();
    expect(store.snapshot().state.todos[1]?.id).toMatch(/^__rpxd_tmp_/);

    expect(() =>
      store.applyEnvelope({
        seq: 1, // stale
        instance: "i1",
        rpcId: sent.at(-1)?.rpcId,
        // biome-ignore lint/suspicious/noExplicitAny: intentionally malformed wire frame
        patches: { length: 1 } as any,
      }),
    ).not.toThrow();
    await expect(p).resolves.toBeUndefined();
    expect(store.confirmed.todos).toHaveLength(1); // stale patches never apply
  });

  it("settles a gap-seq ack whose patches are corrupt (tempIds issued)", async () => {
    const { store, sent, resyncs } = makeStore(addMeta);
    const p = store.call("add", { text: "x" });
    await flushTick();
    expect(store.snapshot().state.todos[1]?.id).toMatch(/^__rpxd_tmp_/);

    expect(() =>
      store.applyEnvelope({
        seq: 5, // gap: expected 2
        instance: "i1",
        rpcId: sent.at(-1)?.rpcId,
        // biome-ignore lint/suspicious/noExplicitAny: intentionally malformed wire frame
        patches: { length: 1 } as any,
      }),
    ).not.toThrow();
    expect(resyncs).toEqual([1]); // gap recovery still requested
    await expect(p).resolves.toBeUndefined();
  });
});

describe("seq handling (§2)", () => {
  it("requests a resync on gap and ignores patches until full arrives", () => {
    const { store, resyncs } = makeStore();
    store.applyEnvelope({
      seq: 5, // gap: expected 2
      instance: "i1",
      patches: [{ op: "replace", path: ["todos", 0, "text"], value: "lost" }],
    });
    expect(resyncs).toEqual([1]);
    expect(store.snapshot().state.todos[0]?.text).toBe("existing");

    store.applyEnvelope({
      seq: 6,
      instance: "i1",
      full: { state: { todos: [], other: { untouched: true } }, session: {} },
    });
    expect(store.seq).toBe(6);
    expect(store.snapshot().state.todos).toHaveLength(0);
  });

  it("ignores stale envelopes but still settles their acks", async () => {
    const { store, sent } = makeStore(addMeta);
    const p = store.call("add", { text: "x" });
    await flushTick();
    store.applyEnvelope({
      seq: 1, // stale
      instance: "i1",
      rpcId: sent[0]?.rpcId,
      patches: [{ op: "replace", path: ["todos", 0, "text"], value: "should-not-apply" }],
    });
    await expect(p).resolves.toBeUndefined();
    expect(store.confirmed.todos[0]?.text).toBe("existing");
  });

  it("ignores envelopes for other instances (multiplexed stream, §2)", () => {
    const { store } = makeStore();
    store.applyEnvelope({
      seq: 99,
      instance: "someone-else",
      full: { state: { todos: [], other: { untouched: true } }, session: {} },
    });
    store.applyEnvelope({
      seq: 2,
      instance: "someone-else",
      patches: [{ op: "replace", path: ["todos", 0, "text"], value: "not-mine" }],
    });
    expect(store.seq).toBe(1); // untouched
    expect(store.confirmed.todos[0]?.text).toBe("existing");
  });

  it("routes $session patches to the session slice", () => {
    const { store } = makeStore();
    store.applyEnvelope({
      seq: 2,
      instance: "i1",
      patches: [{ op: "replace", path: ["$session", "filter"], value: "done" }],
    });
    expect(store.snapshot().session).toEqual({ filter: "done" });
    expect(store.snapshot().state).toEqual(initial);
  });

  it("resends unacked batches for server-side dedupe (§11)", async () => {
    const { store, sent } = makeStore();
    void store.call("a");
    await flushTick();
    store.resendUnacked();
    expect(sent).toHaveLength(2);
    expect(sent[0]?.rpcId).toBe(sent[1]?.rpcId);
  });
});

describe("append op (§2)", () => {
  it("expands append against the confirmed string before applying", () => {
    const { store } = makeStore();
    store.applyEnvelope({
      seq: 2,
      instance: "i1",
      patches: [{ op: "append", path: ["todos", 0, "text"], value: " and more" }],
    });
    expect(store.confirmed.todos[0]?.text).toBe("existing and more");

    store.applyEnvelope({
      seq: 3,
      instance: "i1",
      patches: [{ op: "append", path: ["todos", 0, "text"], value: "!" }],
    });
    expect(store.snapshot().state.todos[0]?.text).toBe("existing and more!");
  });

  it("routes $session appends to the session slice", () => {
    const { store } = makeStore();
    store.applyEnvelope({
      seq: 2,
      instance: "i1",
      patches: [{ op: "append", path: ["$session", "filter"], value: "-done" }],
    });
    expect(store.snapshot().session).toEqual({ filter: "all-done" });
  });

  it("treats a non-string target as a protocol error: skip + resync", () => {
    const { store, resyncs } = makeStore();
    store.applyEnvelope({
      seq: 2,
      instance: "i1",
      patches: [
        { op: "replace", path: ["todos", 0, "text"], value: "should-not-apply" },
        { op: "append", path: ["todos"], value: "boom" },
      ],
    });
    expect(resyncs).toEqual([1]);
    expect(store.confirmed.todos[0]?.text).toBe("existing"); // whole envelope discarded
  });
});

describe("server ↔ client integration", () => {
  interface SrvState {
    todos: Todo[];
  }
  type Sess = Record<string, unknown>;

  it("runs the full loop: optimistic create → server ack → id link → keyOf stability", async () => {
    let n = 0;
    const def: LiveDefinition<SrvState, "/todos", Sess> = {
      setup: () => ({ todos: [] }),
      rpc: {
        create: {
          optimistic: (state: SrvState, { text }: { text: string }, ctx) => {
            state.todos.push({ id: ctx.tempId(), text });
          },
          async handler({ text }: { text: string }, ctx) {
            ctx.patchState((state) => {
              state.todos.push({ id: `srv-${++n}`, text });
            });
          },
        },
      },
    };

    const inst = await LiveInstance.create({
      id: "inst-1",
      def,
      params: {},
      session: {},
      storage: memory(),
      storageKey: "k",
    });

    const store = new LiveStore<SrvState>({
      instance: "inst-1",
      meta: rpcMetaFromDef(def),
      send: (batch) => void inst.handleBatch(batch),
      requestResync: () => inst.resync(),
    });
    inst.addListener((env: Envelope) => store.applyEnvelope(env));
    expect(PROTOCOL_VERSION).toBe(1);
    inst.resync(); // initial snapshot for the late-attached store

    const done = store.call("create", { text: "hello" });
    // Observe the optimistic window right after the microtask flush, before
    // the in-process server acks.
    await Promise.resolve();
    const tempId = store.snapshot().state.todos[0]?.id as string;
    expect(tempId).toMatch(/^__rpxd_tmp_/);

    await done;
    await inst.idle();
    const snap = store.snapshot();
    expect(snap.state.todos).toEqual([{ id: "srv-1", text: "hello" }]);
    expect(snap.state).toEqual(inst.state); // client converged on server truth
    expect(store.keyOf("srv-1")).toBe(tempId); // stable key, no remount
    expect(snap.sync.pending).toBe(false);
  });
});
