/**
 * Wire-protocol conformance (the wire protocol guide, "Invariants (test these)").
 *
 * These pin the four invariants the doc declares normative, plus the envelope /
 * batch shapes. If any of these break, the doc, `protocol.ts`, and the
 * SSE/WS/client seams that share the WIRE CONTRACT anchor must move together.
 */
import { applyPatches, type Patch as ImmerPatch } from "immer";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { LiveInstance } from "../src/instance.ts";
import { live } from "../src/live.ts";
import {
  type Control,
  type Envelope,
  type Patch,
  PROTOCOL_VERSION,
  type RpcBatch,
  type UrlControl,
} from "../src/protocol.ts";
import { memory } from "../src/storage.ts";

const tick = () => new Promise<void>((r) => setTimeout(r, 0));
let counter = 0;

const route = live("/conf")
  .setup(() => ({ todos: [] as { id: string; text: string }[], answer: "" }))
  .rpc("add", (r) =>
    r.input(z.object({ text: z.string().min(1) })).handler(async ({ text }, ctx) => {
      ctx.patchState((s) => {
        s.todos.push({ id: `srv-${++counter}`, text });
      });
    }),
  )
  .rpc("grow", (r) =>
    r.input(z.object({ delta: z.string() })).handler(async ({ delta }, ctx) => {
      // string += emits an `append` patch on the wire (O(delta)).
      ctx.patchState((s) => {
        s.answer += delta;
      });
    }),
  )
  .rpc("stream", (r) =>
    r.handler(async (_p, ctx) => {
      ctx.patchState((s) => {
        s.answer += "x";
      });
      await tick(); // the first flush ships as a mid-handler chunk
      ctx.patchState((s) => {
        s.answer += "y";
      });
    }),
  )
  .rpc("boom", (r) =>
    r.handler(async () => {
      throw new Error("boom");
    }),
  )
  .render(({ state }) => state as unknown);

async function mount() {
  const inst = await LiveInstance.create({
    id: "conf-i",
    def: route.def,
    params: {},
    session: {},
    storage: memory(),
    storageKey: `conf:${++counter}`,
  });
  const envelopes: Envelope[] = [];
  inst.addListener((e) => envelopes.push(e));
  return { inst, envelopes };
}

function batch(rpc: string, payload: unknown, rpcId: string): RpcBatch {
  return { v: PROTOCOL_VERSION, instance: "conf-i", rpcId, calls: [{ rpc, payload }] };
}

/** Apply wire patches (including the rpxd `append` extension) to a confirmed replica. */
function applyWire<T extends object>(state: T, patches: Patch[]): T {
  let next = state;
  for (const p of patches) {
    if (p.op === "append") {
      const cur = p.path.reduce<unknown>((o, k) => (o as Record<PropertyKey, unknown>)[k], next);
      next = applyPatches(next, [
        { op: "replace", path: p.path, value: `${cur ?? ""}${p.value}` } as ImmerPatch,
      ]);
    } else {
      next = applyPatches(next, [p as ImmerPatch]);
    }
  }
  return next;
}

describe("wire-protocol conformance (the wire protocol guide)", () => {
  it("invariant 1: patches over the last full converge to server confirmed state", async () => {
    const { inst, envelopes } = await mount();
    inst.resync(); // baseline full at the current seq
    await inst.handleBatch(batch("add", { text: "a" }, "c1"));
    await inst.handleBatch(batch("grow", { delta: "hello" }, "c2"));
    await inst.handleBatch(batch("stream", {}, "c3"));
    await tick();
    await inst.idle();

    // A full-understanding client: seed at the first full, apply every later
    // patch envelope in seq order (skipping session-slice patches).
    let replica: { todos: unknown[]; answer: string } | undefined;
    for (const env of envelopes) {
      if (env.full) {
        replica = env.full.state as typeof replica;
        continue;
      }
      if (replica && env.patches) {
        replica = applyWire(
          replica as object,
          env.patches.filter((p) => p.path[0] !== "$session"),
        ) as typeof replica;
      }
    }
    expect(replica).toEqual(inst.state);
  });

  it("invariant 2: every batch gets exactly one ack — success or error", async () => {
    const { inst, envelopes } = await mount();
    await inst.handleBatch(batch("add", { text: "a" }, "ok"));
    await inst.handleBatch(batch("boom", {}, "threw"));
    await inst.handleBatch(batch("nope", {}, "unknown"));
    await inst.handleBatch(batch("add", { text: "" }, "invalid")); // fails validation
    await inst.handleBatch({
      v: (PROTOCOL_VERSION + 1) as typeof PROTOCOL_VERSION,
      instance: "conf-i",
      rpcId: "badver",
      calls: [{ rpc: "add", payload: { text: "x" } }],
    });
    await inst.idle();

    const ackFor = (id: string) => envelopes.filter((e) => e.rpcId === id);
    expect(ackFor("ok")).toHaveLength(1);
    expect(ackFor("ok")[0]?.error).toBeUndefined();
    for (const id of ["threw", "unknown", "invalid", "badver"]) {
      const acks = ackFor(id);
      expect(acks).toHaveLength(1); // exactly one ack
      expect(acks[0]?.error).toBeDefined(); // and it's an error ack
    }
  });

  it("invariant 3: a full-only client (ignores patches, resyncs gaps) converges", async () => {
    const { inst, envelopes } = await mount();
    await inst.handleBatch(batch("add", { text: "a" }, "c1"));
    await inst.handleBatch(batch("grow", { delta: "hi" }, "c2"));
    await inst.idle();
    // The client ignored every patch; on the next gap it resyncs and the server
    // answers with a full snapshot that equals server truth.
    const seen = envelopes.length;
    inst.resync();
    const full = envelopes.slice(seen).find((e) => e.full);
    expect(full?.full).toEqual({ state: inst.state, session: inst.session });
  });

  it("invariant 4: envelopes for one instance never leave seq order", async () => {
    const { inst, envelopes } = await mount();
    // Concurrent handlers: a streaming rpc interleaves mid-flushes with plain rpcs.
    await Promise.all([
      inst.handleBatch(batch("stream", {}, "s1")),
      inst.handleBatch(batch("add", { text: "a" }, "a1")),
      inst.handleBatch(batch("grow", { delta: "z" }, "g1")),
    ]);
    await tick();
    await inst.idle();

    expect(envelopes.length).toBeGreaterThan(1);
    for (let i = 1; i < envelopes.length; i++) {
      expect(envelopes[i]?.seq).toBe((envelopes[i - 1]?.seq ?? 0) + 1);
    }
    expect(new Set(envelopes.map((e) => e.instance))).toEqual(new Set(["conf-i"]));
  });

  it("shape pin: literal Envelope/RpcBatch values satisfy the exported types", () => {
    const patchEnv = {
      seq: 2,
      instance: "i",
      patches: [{ op: "replace", path: ["answer"], value: "hi" }],
      rpcId: "c1",
    } satisfies Envelope;
    const fullEnv = {
      seq: 1,
      instance: "i",
      full: { state: { todos: [] }, session: {} },
    } satisfies Envelope;
    const errEnv = {
      seq: 3,
      instance: "i",
      rpcId: "c2",
      error: { name: "ProtocolError", message: "x" },
    } satisfies Envelope;
    const redirectEnv = { seq: 4, instance: "i", redirect: "/login" } satisfies Envelope;
    // A denied WS mount answers unbound (`instance: ""`) with the frame's
    // mountId echoed for correlation (#65).
    const mountDenyEnv = {
      seq: 0,
      instance: "",
      redirect: "/login",
      mountId: "m1",
    } satisfies Envelope;
    const b = {
      v: PROTOCOL_VERSION,
      instance: "i",
      rpcId: "c3",
      calls: [{ rpc: "add", payload: { text: "x" } }],
    } satisfies RpcBatch;

    // `full` carries `{ state, session }`, not a bare unknown (W5).
    expect(fullEnv.full).toEqual({ state: { todos: [] }, session: {} });
    expect(b.calls[0]).toEqual({ rpc: "add", payload: { text: "x" } });
    expect(patchEnv.patches?.[0]?.op).toBe("replace");
    expect(errEnv.error?.name).toBe("ProtocolError");
    expect(redirectEnv.redirect).toBe("/login");
    expect(mountDenyEnv.mountId).toBe("m1");

    // `RpcCall` has no `tempIds` — tempIds are client-local, never on the wire (W4).
    const withExcess = {
      v: PROTOCOL_VERSION,
      instance: "i",
      rpcId: "c4",
      calls: [
        {
          rpc: "add",
          payload: {},
          // @ts-expect-error tempIds is not a field on RpcCall (W4)
          tempIds: ["t1"],
        },
      ],
    } satisfies RpcBatch;
    void withExcess;
  });

  it("shape pin: the `url` control message carries `props`, not `search` (ADR 0002 item 1)", () => {
    // A page's URL query IS its props record — the `url` control message's
    // payload field renamed search → props. This pins the new name and rejects
    // the old one, moving in lockstep with wire-protocol.md's Control union.
    const urlControl = {
      type: "url",
      instance: "i",
      props: { filter: "done" },
    } satisfies UrlControl;
    expect(urlControl.props).toEqual({ filter: "done" });

    // Negative: the OLD field name no longer conforms. `props` is present (so
    // the only defect is the excess property), and `search` is not a field on
    // the `url` control message.
    const legacy = {
      type: "url",
      instance: "i",
      props: { filter: "done" },
      // @ts-expect-error the `url` control carries `props`, not `search` (ADR 0002 item 1)
      search: { filter: "done" },
    } satisfies UrlControl;
    void legacy;

    // The `mount` control now carries `props` too (renamed search → props in
    // ADR 0002 item 6, unifying the vocabulary with the `url` message). Unlike
    // `url`'s raw-string record, mount `props` is a JSON value model.
    const mountControl = {
      type: "mount",
      path: "/board",
      props: { filter: "done", limit: 20 },
    } satisfies Control;
    expect(mountControl.props).toEqual({ filter: "done", limit: 20 });

    // Negative: the OLD field name no longer conforms on `mount` either.
    // `props` is present (so the only defect is the excess property), and
    // `search` is not a field on the `mount` control message.
    const legacyMount = {
      type: "mount",
      path: "/board",
      props: { filter: "done" },
      // @ts-expect-error the `mount` control carries `props`, not `search` (ADR 0002 item 6)
      search: { filter: "done" },
    } satisfies Control;
    void legacyMount;
  });
});
