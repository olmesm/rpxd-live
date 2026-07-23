/**
 * Instance-per-stream (ADR 0003): a live instance belongs to ONE client stream
 * (one tab), not to every tab of the session. These pin the pivot away from
 * ADR 0002 Decision 4's cross-tab sharing:
 *
 * - two streams mounting the same path get DISTINCT instances (cross-tab
 *   isolation — the two-tab filter/URL aliasing class is unexpressible);
 * - the same stream re-mounting a path warm-reuses its own instance (within-tab
 *   sharing — Decision 2's page↔slot identity — is preserved);
 * - a stream receives envelopes ONLY for instances it owns;
 * - a `url` reconcile from one tab leaves the other tab's instance untouched
 *   (the original two-tab filter bug, pinned server-side);
 * - the SSR-born instance is CLAIMED by the stream that presents its attach
 *   token — at stream connect or on a control mount carrying `attach` — so
 *   page↔slot sharing survives any connect/mount arrival order;
 * - a cold control mount (no stream) answers with its attach token so a
 *   later-connecting stream can claim it (the `LiveConnection.mount` flow).
 */
import type { Envelope, LiveDefinition } from "@rpxd/core";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createRpxdHandler } from "../src/handler.ts";

const base = "http://test.local";
const COOKIE = { cookie: "rpxd_sid=session-a" };

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

const chatSchema = z.object({ tools: z.array(z.string()) });
interface ChatState {
  tools: string[];
}
const chatDef: LiveDefinition<ChatState, "/chat", Record<string, unknown>, { tools: string[] }> = {
  setup: () => ({ tools: [] as string[] }),
  load: async ({ props }, ctx) => {
    ctx.patchState((s) => {
      s.tools = props.tools;
    });
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
        this.#pendingRead = read; // keep the in-flight read; drop nothing
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

const connectSse = async (
  handler: ReturnType<typeof makeHandler>,
  query: string,
): Promise<SseReader> =>
  new SseReader(
    await handler.fetch(new Request(`${base}/__rpxd/stream?${query}`, { headers: COOKIE })),
  );

/** Pull the SSR bootstrap out of a rendered document. */
function bootOf(html: string): { instance: string; seq: number; attachToken: string } {
  const json = /<script id="__rpxd" type="application\/json">(.*?)<\/script>/s.exec(html)?.[1];
  return JSON.parse(json as string) as { instance: string; seq: number; attachToken: string };
}

describe("instance-per-stream (ADR 0003)", () => {
  it("two streams mounting the same path get distinct instances", async () => {
    const handler = makeHandler();
    const resA = await control(handler, {
      type: "mount",
      path: "/chat",
      props: { tools: [] },
      stream: "tab-a",
    });
    const resB = await control(handler, {
      type: "mount",
      path: "/chat",
      props: { tools: [] },
      stream: "tab-b",
    });
    const a = (await resA.json()) as { instance: string };
    const b = (await resB.json()) as { instance: string };
    expect(a.instance).not.toBe(b.instance);
    expect(handler.instanceCount).toBe(2);
    await handler.dispose();
  });

  it("the same stream re-mounting the same path warm-reuses its own instance", async () => {
    const handler = makeHandler();
    const res1 = await control(handler, {
      type: "mount",
      path: "/chat",
      props: { tools: [] },
      stream: "tab-a",
    });
    const res2 = await control(handler, {
      type: "mount",
      path: "/chat",
      props: { tools: [] },
      stream: "tab-a",
    });
    const first = (await res1.json()) as { instance: string };
    const second = (await res2.json()) as { instance: string };
    expect(second.instance).toBe(first.instance);
    expect(handler.instanceCount).toBe(1);
    await handler.dispose();
  });

  it("two page GETs build distinct instances", async () => {
    const handler = makeHandler();
    const bootA = bootOf(
      await (await handler.fetch(new Request(`${base}/org/9/board`, { headers: COOKIE }))).text(),
    );
    const bootB = bootOf(
      await (await handler.fetch(new Request(`${base}/org/9/board`, { headers: COOKIE }))).text(),
    );
    expect(bootA.instance).not.toBe(bootB.instance);
    expect(handler.instanceCount).toBe(2);
    await handler.dispose();
  });

  it("a connecting stream is NOT subscribed to another stream's instances", async () => {
    const handler = makeHandler();
    const sseA = await connectSse(handler, "stream=tab-a");
    const res = await control(handler, {
      type: "mount",
      path: "/chat",
      props: { tools: ["search"] },
      stream: "tab-a",
    });
    const { instance } = (await res.json()) as { instance: string };
    // tab-a sees its own snapshot…
    const full = await sseA.next();
    expect(full?.instance).toBe(instance);
    // …but a SECOND tab connecting afterwards must not be fanned tab-a's state.
    const sseB = await connectSse(handler, "stream=tab-b");
    expect(await sseB.next(200)).toBeNull();
    await handler.dispose();
  });

  it("a url reconcile from one tab leaves the other tab's instance untouched (the two-tab filter bug)", async () => {
    const handler = makeHandler();
    const sseA = await connectSse(handler, "stream=tab-a");
    const sseB = await connectSse(handler, "stream=tab-b");
    const a = (await (
      await control(handler, { type: "mount", path: "/org/1/board", props: {}, stream: "tab-a" })
    ).json()) as { instance: string };
    const b = (await (
      await control(handler, { type: "mount", path: "/org/1/board", props: {}, stream: "tab-b" })
    ).json()) as { instance: string };
    expect(a.instance).not.toBe(b.instance);
    // Drain both tabs' initial snapshots.
    expect((await sseA.next())?.full).toBeTruthy();
    expect((await sseB.next())?.full).toBeTruthy();

    // Tab A changes its filter (nav.patch → url control)…
    const patched = await control(handler, {
      type: "url",
      instance: a.instance,
      props: { filter: "done" },
    });
    expect(patched.status).toBe(204);
    // …tab A reconciles, and tab B hears NOTHING — its filter is its own.
    const envA = await sseA.next();
    expect(envA?.instance).toBe(a.instance);
    expect(await sseB.next(200)).toBeNull();
    await handler.dispose();
  });

  it("the attach-claimed SSR instance is warm-reused by the claiming stream's later mounts", async () => {
    const handler = makeHandler();
    const boot = bootOf(
      await (await handler.fetch(new Request(`${base}/org/9/board`, { headers: COOKIE }))).text(),
    );
    // The tab's stream connects with the bootstrap token — claiming the instance…
    const sse = await connectSse(
      handler,
      `stream=tab-a&attach=${boot.attachToken}&seq=${boot.seq}`,
    );
    // …so a control mount of the same identity from the SAME stream shares it
    // (Decision 2 within-tab page↔slot sharing survives the pivot).
    const res = await control(handler, {
      type: "mount",
      path: "/org/9/board",
      props: {},
      stream: "tab-a",
    });
    const { instance } = (await res.json()) as { instance: string };
    expect(instance).toBe(boot.instance);
    expect(handler.instanceCount).toBe(1);
    // Adoption is silent (the client already holds the SSR snapshot) — prove
    // liveness by driving an rpc and reading its ack on this stream.
    await handler.fetch(
      new Request(`${base}/__rpxd/rpc`, {
        method: "POST",
        headers: COOKIE,
        body: JSON.stringify({
          v: 1,
          instance: boot.instance,
          rpcId: "r1",
          calls: [{ rpc: "add", payload: { item: "x" } }],
        }),
      }),
    );
    const ack = await sse.next();
    expect(ack?.instance).toBe(boot.instance);
    expect(ack?.rpcId).toBe("r1");
    await handler.dispose();
  });

  it("a control mount carrying the attach token claims the SSR instance before its stream connects", async () => {
    const handler = makeHandler();
    const boot = bootOf(
      await (await handler.fetch(new Request(`${base}/org/9/board`, { headers: COOKIE }))).text(),
    );
    // Mount RACES AHEAD of the stream connect (slot mount on page boot) — the
    // token makes the claim order-free.
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
    // The stream connects afterwards and still owns the instance — adoption is
    // silent (token+seq match), so prove liveness via an rpc ack.
    const sse = await connectSse(
      handler,
      `stream=tab-a&attach=${boot.attachToken}&seq=${boot.seq}`,
    );
    await handler.fetch(
      new Request(`${base}/__rpxd/rpc`, {
        method: "POST",
        headers: COOKIE,
        body: JSON.stringify({
          v: 1,
          instance: boot.instance,
          rpcId: "r1",
          calls: [{ rpc: "add", payload: { item: "x" } }],
        }),
      }),
    );
    const ack = await sse.next();
    expect(ack?.instance).toBe(boot.instance);
    expect(ack?.rpcId).toBe("r1");
    await handler.dispose();
  });

  it("a cold mount (no stream) answers with its attach token; the connecting stream claims it", async () => {
    const handler = makeHandler();
    const res = await control(handler, { type: "mount", path: "/chat", props: { tools: ["a"] } });
    const body = (await res.json()) as { instance: string; attach?: string };
    expect(body.attach).toBeDefined(); // the LiveConnection.mount adoption handle
    const sse = await connectSse(handler, `stream=tab-a&attach=${body.attach}&seq=0`);
    const env = await sse.next();
    expect(env?.instance).toBe(body.instance);
    expect((env?.full?.state as ChatState | undefined)?.tools).toEqual(["a"]);
    await handler.dispose();
  });

  it("an SSE reconnect (same stream id) re-subscribes the stream's own instances", async () => {
    const handler = makeHandler();
    await connectSse(handler, "stream=tab-a");
    const res = await control(handler, {
      type: "mount",
      path: "/chat",
      props: { tools: ["x"] },
      stream: "tab-a",
    });
    const { instance } = (await res.json()) as { instance: string };
    // The tab reconnects (network blip): the SAME stream id recovers its instance.
    const reconnected = await connectSse(handler, "stream=tab-a");
    const env = await reconnected.next();
    expect(env?.instance).toBe(instance);
    expect(env?.full).toBeTruthy();
    await handler.dispose();
  });

  it("a GET after a principal change never restores the old principal's session slice", async () => {
    // Fresh instances always build on GET, so the snapshot-restore path (§9
    // session continuity) runs on EVERY reload — it must apply the same
    // principal-change rule the warm-reuse branch does (§10): a snapshot whose
    // session no longer matches the freshly authenticated one is stale (the
    // sign-out → reload flow) and must be dropped, not revived.
    const def: LiveDefinition<{ who: string }, "/", { user?: string }> = {
      setup: (ctx) => ({ who: (ctx.session as { user?: string }).user ?? "anon" }),
    };
    const handler = createRpxdHandler({
      routes: [{ path: "/", def }],
      authenticate: (req) => ({ user: req.headers.get("x-user") ?? undefined }),
      warmTtlMs: 1000,
      attachTtlMs: 1000,
      cookie: { sign: false },
    });
    const get = (user?: string) =>
      handler.fetch(
        new Request(`${base}/`, {
          headers: user ? { ...COOKIE, "x-user": user } : COOKIE,
        }),
      );
    expect(await (await get("alice")).text()).toContain('"who":"alice"');
    // Signed out (no user): the reload must render anon — not alice restored
    // from the shared `${sid}:${identity}` snapshot row.
    expect(await (await get()).text()).toContain('"who":"anon"');
    await handler.dispose();
  });
});
