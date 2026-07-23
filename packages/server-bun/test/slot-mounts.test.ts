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
let chatLoad = 0;
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
    chatLoad++;
    ctx.patchState((s) => {
      s.tools = props.tools;
    });
  },
};

// A PARAM page route (`/$slug`) that concretely matches `/chat` — the collision
// the warm-reuse pattern guard (review R1 finding 1) must resolve: a page at
// `/chat` (via `/$slug`) and the `/chat` slot are DIFFERENT live objects that
// fill to the same concrete pathname, so they must never share one session key.
let pageSetup = 0;
let pageGuard = 0;
let pageLoad = 0;
interface PageState {
  slug: string;
  loaded: boolean;
}
const pageDef: LiveDefinition<PageState, "/$slug", Record<string, unknown>> = {
  setup: (ctx) => {
    pageSetup++;
    return { slug: ctx.params.slug, loaded: false };
  },
  guard: () => {
    pageGuard++;
  },
  load: async (_url, ctx) => {
    pageLoad++;
    ctx.patchState((s) => {
      s.loaded = true;
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
  chatLoad = 0;
  return createRpxdHandler({
    routes: [{ path: "/org/$orgId/board", def: boardDef }],
    slots: [{ path: "/chat", def: chatDef, props: chatSchema }],
    warmTtlMs: 1000,
    attachTtlMs: 1000,
    cookie: { sign: false },
    ...overrides,
  });
}

// A handler whose PAGE route is `/$slug` (matches the concrete `/chat`) plus the
// `/chat` slot — the finding-1 collision fixture.
function makeSlugHandler(overrides: Partial<Parameters<typeof createRpxdHandler>[0]> = {}) {
  chatSetup = 0;
  chatGuard = 0;
  pageSetup = 0;
  pageGuard = 0;
  pageLoad = 0;
  return createRpxdHandler({
    routes: [{ path: "/$slug", def: pageDef }],
    slots: [{ path: "/chat", def: chatDef, props: chatSchema }],
    warmTtlMs: 1000,
    attachTtlMs: 1000,
    cookie: { sign: false },
    ...overrides,
  });
}

/** Pull the SSR bootstrap `{ instance, snapshot }` out of a rendered document. */
function bootOf(html: string): { instance: string; snapshot: { state: PageState } } {
  const json = /<script id="__rpxd" type="application\/json">(.*?)<\/script>/s.exec(html)?.[1];
  return JSON.parse(json as string) as { instance: string; snapshot: { state: PageState } };
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
    ) as { instance: string; attachToken: string };

    // …and a control-plane mount of the SAME concrete path from the SAME TAB
    // shares it (Decision 2 — a routed page is a mountable slot by construction).
    // Instances are stream-scoped (ADR 0003), so the mount presents the tab's
    // bootstrap attach token to CLAIM the SSR-born instance — order-free with
    // respect to the stream connect (which hasn't happened here).
    const res = await control(handler, {
      type: "mount",
      path: "/org/9/board",
      props: {},
      stream: "tab-a",
      attach: boot.attachToken,
    });
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

  it("finding 1: a GET matching a param route is served as the PAGE, not a warm slot at the same pathname", async () => {
    const handler = makeSlugHandler();
    // Mount the `/chat` SLOT via the control plane (keyed at pathname `/chat`).
    const slotRes = await control(handler, { type: "mount", path: "/chat", props: { tools: [] } });
    const { instance: slotId } = (await slotRes.json()) as { instance: string };
    expect(handler.instanceCount).toBe(1);
    expect(chatSetup).toBe(1);

    // A browser GET `/chat` matches the `/$slug` PAGE route (not the slot). It
    // must build + serve the page (its own guard+load run), NOT adopt the warm
    // slot at the colliding pathname and skip the page's lifecycle entirely.
    const res = await handler.fetch(new Request(`${base}/chat`, { headers: COOKIE }));
    expect(res.status).toBe(200);
    const boot = bootOf(await res.text());
    expect(boot.instance).not.toBe(slotId); // NOT the slot instance
    expect(boot.snapshot.state.slug).toBe("chat"); // the page's own `/$slug` state
    expect(boot.snapshot.state.loaded).toBe(true); // the page's load RAN
    expect(pageGuard).toBe(1);
    expect(pageLoad).toBe(1);
    // Both coexist under distinct (pattern-qualified) keys; the slot is untouched.
    expect(handler.instanceCount).toBe(2);
    await handler.dispose();
  });

  it("finding 1: a slot mount builds its OWN instance even when a param-route page is warm at the same pathname", async () => {
    const handler = makeSlugHandler();
    // A browser GET `/chat` mounts the `/$slug` PAGE (keyed at pathname `/chat`).
    const boot = bootOf(
      await (await handler.fetch(new Request(`${base}/chat`, { headers: COOKIE }))).text(),
    );
    const pageId = boot.instance;
    expect(handler.instanceCount).toBe(1);
    expect(pageSetup).toBe(1);

    // A control-plane mount of the `/chat` SLOT must build its OWN instance
    // (running chat's setup/load), not warm-reuse the page instance and reconcile
    // the page def with slot props.
    const slotRes = await control(handler, {
      type: "mount",
      path: "/chat",
      props: { tools: ["search"] },
    });
    expect(slotRes.status).toBe(200);
    const { instance: slotId, path } = (await slotRes.json()) as { instance: string; path: string };
    expect(slotId).not.toBe(pageId);
    expect(path).toBe("/chat"); // matched the literal slot pattern, not `/$slug`
    expect(chatSetup).toBe(1); // the slot's own setup ran
    expect(pageSetup).toBe(1); // the page was NOT rebuilt
    expect(handler.instanceCount).toBe(2);
    await handler.dispose();
  });

  it("finding 1: a warm param-route page still shares its instance with a control-plane mount of the SAME pattern", async () => {
    // The coexistence fix must NOT break Decision-2 instance sharing: when the
    // control-plane mount resolves to the SAME pattern as the GET page (no literal
    // slot shadows it), the key is identical and the instance is shared.
    const handler = makeSlugHandler({ slots: [] });
    const boot = bootOf(
      await (await handler.fetch(new Request(`${base}/about`, { headers: COOKIE }))).text(),
    ) as unknown as { instance: string; attachToken: string };
    // Stream-scoped instances (ADR 0003): the tab's mount claims the SSR-born
    // instance via its bootstrap attach token (same pattern → same identity).
    const res = await control(handler, {
      type: "mount",
      path: "/about",
      props: {},
      stream: "tab-a",
      attach: boot.attachToken,
    });
    const { instance } = (await res.json()) as { instance: string };
    expect(instance).toBe(boot.instance); // shared — same pattern, same concrete path
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

  // ADR 0002 items 8/9/11 — the WS slot-join double layer (PR #129 CI): on WS the
  // socket *is* the stream, so after the control mount resolves the instance id the
  // client sends a `mount` FRAME to join its freshly-registered store to the socket.
  // Under stream-scoped instances (ADR 0003) the second-TAB variant of this race is
  // gone (another tab mounts its own instance), but the same-socket variant remains:
  // a SECOND same-identity <LiveSlot> on one page registers its own store and sends
  // its own join frame while the instance is already on the socket. The idempotent
  // subscribe early-returns, so the frame's resync is the ONLY moment that late
  // store can be snapshotted — and item 8's dedup must keep it from re-running `load`.
  it("WS: a mount frame for a slot already on this socket resyncs the newly-registered store without re-running load", async () => {
    const handler = makeHandler();

    // First slot: the frame builds the instance (scoped to this socket) and resyncs.
    const envs: Envelope[] = [];
    const sock = handler.socket("session-a", {}, (e) => envs.push(e));
    await sock.message(JSON.stringify({ type: "mount", path: "/chat", props: { tools: ["x"] } }));
    expect(chatLoad).toBe(1);
    expect(envs.some((e) => e.full)).toBe(true); // first store got its snapshot
    envs.length = 0; // from here, only what the second join FRAME produces counts

    // Second same-identity slot on the same page: warm on THIS socket already.
    await sock.message(JSON.stringify({ type: "mount", path: "/chat", props: { tools: ["x"] } }));

    // Item 8 dedup holds across the frame path: identical props → no reload.
    expect(chatLoad).toBe(1);
    // The join frame MUST resync the late-registered store. Without it the warm
    // instance is already on this socket (idempotent subscribe → early return), no
    // envelope is emitted, and the second slot's store hangs in `fallback` forever.
    expect(envs.some((e) => e.full)).toBe(true);

    sock.close();
    await handler.dispose();
  });

  it("WS: a mount frame with CHANGED props on a warm slot re-runs load AND resyncs (tier-1-via-frame preserved)", async () => {
    const handler = makeHandler();
    const aEnvs: Envelope[] = [];
    const sockA = handler.socket("session-a", {}, (e) => aEnvs.push(e));
    await sockA.message(JSON.stringify({ type: "mount", path: "/chat", props: { tools: ["x"] } }));
    expect(chatLoad).toBe(1);

    // A second socket, warm slot, but the join frame legitimately carries NEW props:
    // the reconcile must re-run `load` (item 8: changed props reload) and the late
    // store must be snapshotted with the new state.
    const bEnvs: Envelope[] = [];
    const sockB = handler.socket("session-a", {}, (e) => bEnvs.push(e));
    bEnvs.length = 0;
    await sockB.message(JSON.stringify({ type: "mount", path: "/chat", props: { tools: ["y"] } }));

    expect(chatLoad).toBe(2); // changed props → load re-ran
    const snap = bEnvs.find((e) => e.full);
    expect((snap?.full?.state as ChatState | undefined)?.tools).toEqual(["y"]);

    sockA.close();
    sockB.close();
    await handler.dispose();
  });
});
