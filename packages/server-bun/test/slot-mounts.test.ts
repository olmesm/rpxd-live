/**
 * Union-table control-plane mounts (ADR 0002 item 6): a mount-only `slot`
 * registration is mountable over the control plane but not servable as a page,
 * flowing through the SAME `mountInstance` → `buildInstance` path as a routed
 * page (stop-signal #1 — parameterization, not a fork). These pin: a slot mount
 * registers + snapshots on the joined stream; props validation runs before
 * guard/setup (422 / WS error envelope); a slot guard deny allocates nothing;
 * boot-time union uniqueness; the shared-instance feature (a routed page mounted
 * via control plane reuses its GET instance); a slot pattern 404s as a GET; and
 * a subscribed slot survives session-cap pressure.
 */
import { type Envelope, type LiveDefinition, type PROTOCOL_VERSION, redirect } from "@rpxd/core";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createRpxdHandler, type RouteRegistration } from "../src/handler.ts";

const base = "http://test.local";
const COOKIE = { cookie: "rpxd_sid=session-a" };
const V = 1 as typeof PROTOCOL_VERSION;

interface BoardState {
  items: string[];
  orgId: string;
  filter?: string;
}
const boardDef: LiveDefinition<BoardState, "/org/$orgId/board", Record<string, unknown>> = {
  setup: (ctx) => ({ items: ["first"], orgId: ctx.params.orgId }),
  load: async ({ props }, ctx) => {
    ctx.patchState((s) => {
      s.filter = (props.filter as string) ?? "all";
    });
  },
  rpc: {
    async add({ item }: { item: string }, ctx) {
      ctx.patchState((state) => {
        state.items.push(item);
      });
    },
  },
};

// A mount-only slot: a chat panel with a typed props schema. Spies prove
// guard/setup never run when validation rejects.
let chatSetup = 0;
let chatGuard = 0;
const chatSchema = z.object({ tools: z.array(z.string()) });
interface ChatState {
  tools: string[];
}
const chatDef: LiveDefinition<ChatState, "/chat", Record<string, unknown>, { tools: string[] }> = {
  setup: () => {
    chatSetup++;
    return { tools: [] as string[] };
  },
  guard: () => {
    chatGuard++;
  },
  load: async ({ props }, ctx) => {
    ctx.patchState((s) => {
      s.tools = props.tools;
    });
  },
};

// A mount-only slot whose guard denies — nothing must be allocated.
const deniedSlotDef: LiveDefinition<{ ok: boolean }, "/secret", Record<string, unknown>> = {
  setup: () => ({ ok: true }),
  guard: () => {
    throw redirect("/login");
  },
};

/** Incremental SSE parser over a streaming Response (mirrors handler.test.ts). */
class SseReader {
  #reader: ReadableStreamDefaultReader<Uint8Array>;
  #decoder = new TextDecoder();
  #buf = "";
  #queue: Envelope[] = [];
  #pendingRead: ReturnType<ReadableStreamDefaultReader<Uint8Array>["read"]> | undefined;

  constructor(res: Response) {
    this.#reader = (res.body as ReadableStream<Uint8Array>).getReader();
  }

  async next(timeoutMs = 700): Promise<Envelope | null> {
    const deadline = Date.now() + timeoutMs;
    while (this.#queue.length === 0) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return null;
      const read = this.#pendingRead ?? this.#reader.read();
      const result = await Promise.race([
        read,
        new Promise<"timeout">((r) => setTimeout(() => r("timeout"), remaining)),
      ]);
      if (result === "timeout") {
        this.#pendingRead = read;
        return null;
      }
      this.#pendingRead = undefined;
      if (result.done) return null;
      this.#buf += this.#decoder.decode(result.value);
      let idx = this.#buf.indexOf("\n\n");
      while (idx !== -1) {
        const chunk = this.#buf.slice(0, idx);
        this.#buf = this.#buf.slice(idx + 2);
        const data = chunk.split("\n").find((l) => l.startsWith("data: "));
        if (data) this.#queue.push(JSON.parse(data.slice(6)) as Envelope);
        idx = this.#buf.indexOf("\n\n");
      }
    }
    return this.#queue.shift() as Envelope;
  }
}

function makeHandler(overrides: Partial<Parameters<typeof createRpxdHandler>[0]> = {}) {
  chatSetup = 0;
  chatGuard = 0;
  return createRpxdHandler({
    routes: [{ path: "/org/$orgId/board", def: boardDef }],
    slots: [{ path: "/chat", def: chatDef, props: chatSchema }],
    warmTtlMs: 1000,
    attachTtlMs: 1000,
    cookie: { sign: false },
    ...overrides,
  });
}

const control = (handler: ReturnType<typeof makeHandler>, body: unknown, headers = COOKIE) =>
  handler.fetch(
    new Request(`${base}/__rpxd/control`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    }),
  );

describe("union-table control-plane mounts (ADR 0002 item 6)", () => {
  it("mounts a mount-only slot pattern and flows its snapshot on the joined stream", async () => {
    const handler = makeHandler();
    const sse = new SseReader(
      await handler.fetch(new Request(`${base}/__rpxd/stream?stream=s1`, { headers: COOKIE })),
    );
    const res = await control(handler, {
      type: "mount",
      path: "/chat",
      props: { tools: ["search", "edit"] },
      stream: "s1",
    });
    expect(res.status).toBe(200);
    const { instance } = (await res.json()) as { instance: string };
    expect(handler.instanceCount).toBe(1);

    const full = await sse.next();
    expect(full?.instance).toBe(instance);
    expect((full?.full?.state as ChatState).tools).toEqual(["search", "edit"]);
    expect(chatSetup).toBe(1);
    expect(chatGuard).toBe(1);
    await handler.dispose();
  });

  it("rejects invalid slot props with 422 — setup and guard never run, nothing allocated", async () => {
    const handler = makeHandler();
    const res = await control(handler, {
      type: "mount",
      path: "/chat",
      props: { tools: "not-an-array" }, // schema wants string[]
    });
    expect(res.status).toBe(422);
    expect(handler.instanceCount).toBe(0);
    expect(chatSetup).toBe(0);
    expect(chatGuard).toBe(0);
    await handler.dispose();
  });

  it("answers an invalid slot mount over WS with an error envelope by mountId (no allocation)", async () => {
    const handler = makeHandler();
    const envelopes: Envelope[] = [];
    const sock = handler.socket("session-a", {}, (env) => envelopes.push(env));
    await sock.message(
      JSON.stringify({ type: "mount", path: "/chat", props: { tools: 5 }, mountId: "m1" }),
    );
    const err = envelopes.find((e) => e.mountId === "m1");
    expect(err?.instance).toBe(""); // unbound — no instance was built
    expect(err?.error?.name).toBe("ValidationError");
    expect(handler.instanceCount).toBe(0);
    expect(chatSetup).toBe(0);
    sock.close();
    await handler.dispose();
  });

  it("returns { redirect } and allocates nothing when a slot guard denies", async () => {
    const handler = makeHandler({ slots: [{ path: "/secret", def: deniedSlotDef }] });
    const res = await control(handler, { type: "mount", path: "/secret", props: {} });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ redirect: "/login" });
    expect(handler.instanceCount).toBe(0);
    await handler.dispose();
  });

  it("throws at construction on a duplicate pattern across routes and slots (names the pattern)", () => {
    expect(() =>
      createRpxdHandler({
        routes: [{ path: "/dup", def: boardDef as RouteRegistration["def"] }],
        slots: [{ path: "/dup", def: chatDef as RouteRegistration["def"] }],
        cookie: { sign: false },
      }),
    ).toThrow(/\/dup/);
  });

  it("SHARED INSTANCE: mounting a routed page over the control plane reuses its GET instance", async () => {
    const handler = makeHandler();
    // A page GET mounts + SSRs the instance…
    const html = await (
      await handler.fetch(new Request(`${base}/org/9/board`, { headers: COOKIE }))
    ).text();
    const boot = JSON.parse(
      /<script id="__rpxd" type="application\/json">(.*?)<\/script>/s.exec(html)?.[1] as string,
    ) as { instance: string };

    // …and a control-plane mount of the SAME concrete path in the SAME session
    // shares it (Decision 2 — a routed page is a mountable slot by construction).
    const res = await control(handler, { type: "mount", path: "/org/9/board", props: {} });
    const { instance } = (await res.json()) as { instance: string };
    expect(instance).toBe(boot.instance);
    expect(handler.instanceCount).toBe(1);
    await handler.dispose();
  });

  it("404s a mount-only slot pattern requested as a browser GET (pages only)", async () => {
    const handler = makeHandler();
    const res = await handler.fetch(new Request(`${base}/chat`, { headers: COOKIE }));
    expect(res.status).toBe(404);
    expect(handler.instanceCount).toBe(0);
    await handler.dispose();
  });

  it("never sheds a subscribed slot under session-cap pressure", async () => {
    const handler = makeHandler({ maxInstancesPerSession: 2 });
    // A slot subscribed to a live stream (subscriberCount > 0).
    const sse = new SseReader(
      await handler.fetch(new Request(`${base}/__rpxd/stream?stream=s1`, { headers: COOKIE })),
    );
    const chatRes = await control(handler, {
      type: "mount",
      path: "/chat",
      props: { tools: [] },
      stream: "s1",
    });
    const { instance: chat } = (await chatRes.json()) as { instance: string };
    await sse.next(); // chat's snapshot → subscribed

    // Two idle routed mounts push over the cap; the shed must skip the
    // subscribed slot and drop an idle page instead.
    await control(handler, { type: "mount", path: "/org/1/board", props: {} });
    await control(handler, { type: "mount", path: "/org/2/board", props: {} });

    // The subscribed slot survives; a probe (empty rpc batch) still resolves it.
    const probe = await handler.fetch(
      new Request(`${base}/__rpxd/rpc`, {
        method: "POST",
        headers: COOKIE,
        body: JSON.stringify({ v: V, instance: chat, rpcId: "p", calls: [] }),
      }),
    );
    expect(probe.status).toBe(202); // 202 = still owned/live; 404 would mean evicted
    await handler.dispose();
  });

  it("404s a GET to a slot pattern even when that slot is already warm (GET serves pages only)", async () => {
    const handler = makeHandler();
    // Warm the slot via the control plane (keyed by its pathname in the session).
    await control(handler, { type: "mount", path: "/chat", props: { tools: [] } });
    expect(handler.instanceCount).toBe(1);
    // A browser GET of the same pathname must NOT adopt/serve the warm slot —
    // GET matches routes only (a slot is not page-addressable, ADR 0002 item 6).
    const res = await handler.fetch(new Request(`${base}/chat`, { headers: COOKIE }));
    expect(res.status).toBe(404);
    // …and the warm slot instance is left untouched (not evicted, not served).
    expect(handler.instanceCount).toBe(1);
    await handler.dispose();
  });

  it("passes schema-less slot props through raw (back-compat)", async () => {
    const rawSlot: LiveDefinition<{ seen: unknown }, "/raw", Record<string, unknown>> = {
      setup: () => ({ seen: null }),
      load: async ({ props }, ctx) => {
        ctx.patchState((s) => {
          s.seen = props;
        });
      },
    };
    const handler = makeHandler({ slots: [{ path: "/raw", def: rawSlot }] });
    const sse = new SseReader(
      await handler.fetch(new Request(`${base}/__rpxd/stream?stream=s1`, { headers: COOKIE })),
    );
    await control(handler, {
      type: "mount",
      path: "/raw",
      props: { filter: "done" },
      stream: "s1",
    });
    const full = await sse.next();
    expect((full?.full?.state as { seen: unknown }).seen).toEqual({ filter: "done" });
    await handler.dispose();
  });
});
