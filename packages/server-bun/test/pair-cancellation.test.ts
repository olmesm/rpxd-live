/**
 * Release/mount pair cancellation — SERVER race behavior (ADR 0002 item 12).
 *
 * The client cancels a same-tick release+mount pair before the wire, so the
 * server may never see that exact race from a real client. But the ADR still
 * demands the server pin the underlying behavior directly (control messages by
 * hand): a mount → release → immediate re-mount of one identity must reuse the
 * SAME instance (setup once, state intact in the re-mount's resync snapshot),
 * and a release must NOT let the eviction timer fire early once the instance is
 * re-subscribed. Together these are why the client CAN cancel a pair: the server
 * never tore the instance down between the release and the re-mount.
 */
import type { Envelope, LiveDefinition, PROTOCOL_VERSION } from "@rpxd/core";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createRpxdHandler } from "../src/handler.ts";

const base = "http://test.local";
const COOKIE = { cookie: "rpxd_sid=session-a" };
const V = 1 as typeof PROTOCOL_VERSION;

let chatSetup = 0;
let chatGuard = 0;
const chatSchema = z.object({ tools: z.array(z.string()) });
interface ChatState {
  tools: string[];
  log: string[];
}
const chatDef: LiveDefinition<ChatState, "/chat", Record<string, unknown>, { tools: string[] }> = {
  setup: () => {
    chatSetup++;
    return { tools: [] as string[], log: [] as string[] };
  },
  guard: () => {
    chatGuard++;
  },
  load: async ({ props }, ctx) => {
    ctx.patchState((s) => {
      s.tools = props.tools;
    });
  },
  rpc: {
    async add({ item }: { item: string }, ctx) {
      ctx.patchState((s) => {
        s.log.push(item);
      });
    },
  },
};

/** Incremental SSE parser over a streaming Response (mirrors slot-mounts.test.ts). */
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

  /** Drain until a full snapshot whose predicate holds (or null on timeout). */
  async fullMatching(pred: (s: ChatState) => boolean): Promise<Envelope | null> {
    for (;;) {
      const env = await this.next();
      if (!env) return null;
      if (env.full && pred(env.full.state as ChatState)) return env;
    }
  }
}

function makeHandler(overrides: Partial<Parameters<typeof createRpxdHandler>[0]> = {}) {
  chatSetup = 0;
  chatGuard = 0;
  return createRpxdHandler({
    slots: [{ path: "/chat", def: chatDef, props: chatSchema }],
    routes: [],
    warmTtlMs: 1000,
    attachTtlMs: 1000,
    cookie: { sign: false },
    ...overrides,
  });
}

const control = (handler: ReturnType<typeof makeHandler>, body: unknown) =>
  handler.fetch(
    new Request(`${base}/__rpxd/control`, {
      method: "POST",
      headers: COOKIE,
      body: JSON.stringify(body),
    }),
  );

const rpc = (handler: ReturnType<typeof makeHandler>, instance: string, item: string) =>
  handler.fetch(
    new Request(`${base}/__rpxd/rpc`, {
      method: "POST",
      headers: COOKIE,
      body: JSON.stringify({
        v: V,
        instance,
        rpcId: `r-${item}`,
        calls: [{ rpc: "add", payload: { item } }],
      }),
    }),
  );

/** Read-only liveness probe: 202 = instance still owned/live, 404 = evicted. */
const alive = async (handler: ReturnType<typeof makeHandler>, instance: string) =>
  (
    await handler.fetch(
      new Request(`${base}/__rpxd/rpc`, {
        method: "POST",
        headers: COOKIE,
        body: JSON.stringify({ v: V, instance, rpcId: "probe", calls: [] }),
      }),
    )
  ).status === 202;

describe("server race: mount → release → re-mount reuses the instance (ADR 0002 item 12)", () => {
  it("re-mount of a released-but-not-evicted key keeps the same id, setup once, state intact", async () => {
    const handler = makeHandler();
    const sse = new SseReader(
      await handler.fetch(new Request(`${base}/__rpxd/stream?stream=s1`, { headers: COOKIE })),
    );

    // Mount the slot and join it to the stream.
    const mountRes = await control(handler, {
      type: "mount",
      path: "/chat",
      props: { tools: ["search"] },
      stream: "s1",
    });
    const { instance } = (await mountRes.json()) as { instance: string };
    expect(chatSetup).toBe(1);
    // First snapshot: load applied tools, log empty.
    const first = await sse.fullMatching((s) => s.tools.length > 0);
    expect((first?.full?.state as ChatState).log).toEqual([]);

    // A state mutation BEFORE the release — this is the state that must survive.
    await rpc(handler, instance, "kept");
    // Drain the patch ack so it doesn't confuse the later full-snapshot read.
    await sse.next();

    // Release the instance from the stream (the client's deferred release), then
    // immediately re-mount the SAME identity (the next page's slot).
    await control(handler, { type: "release", instance, stream: "s1" });
    const reRes = await control(handler, {
      type: "mount",
      path: "/chat",
      props: { tools: ["search"] },
      stream: "s1",
    });
    const { instance: reInstance } = (await reRes.json()) as { instance: string };

    // Same instance — warm reuse, not a fresh build.
    expect(reInstance).toBe(instance);
    expect(chatSetup).toBe(1); // setup ran once total across the whole race
    // guard re-ran on the re-mount (item 8: authorization freshness never
    // weakened) — once at the initial build, once on the warm re-mount reconcile.
    expect(chatGuard).toBe(2);
    expect(handler.instanceCount).toBe(1);
    // The re-subscribe resyncs a full snapshot carrying the pre-release mutation.
    const resync = await sse.fullMatching((s) => s.log.includes("kept"));
    expect(resync).not.toBeNull();
    expect((resync?.full?.state as ChatState).tools).toEqual(["search"]);
    await handler.dispose();
  });

  it("changed props on the re-mount re-runs load (item 8) but preserves the instance + prior state", async () => {
    const handler = makeHandler();
    const sse = new SseReader(
      await handler.fetch(new Request(`${base}/__rpxd/stream?stream=s1`, { headers: COOKIE })),
    );
    const { instance } = (await (
      await control(handler, {
        type: "mount",
        path: "/chat",
        props: { tools: ["a"] },
        stream: "s1",
      })
    ).json()) as { instance: string };
    await sse.fullMatching((s) => s.tools.length > 0);
    await rpc(handler, instance, "kept");
    await sse.next();

    await control(handler, { type: "release", instance, stream: "s1" });
    // Re-mount with DIFFERENT props — the client forwards this as the pair's one
    // `url` patch; load re-runs (props changed) but the instance is reused.
    const reRes = await control(handler, {
      type: "mount",
      path: "/chat",
      props: { tools: ["b"] },
      stream: "s1",
    });
    expect(((await reRes.json()) as { instance: string }).instance).toBe(instance);
    expect(chatSetup).toBe(1);
    // New tools from the re-load, and the pre-release log entry still present.
    const snap = await sse.fullMatching((s) => s.tools.includes("b"));
    expect((snap?.full?.state as ChatState).log).toEqual(["kept"]);
    await handler.dispose();
  });

  it("a released instance re-subscribed before its warm TTL is not evicted early", async () => {
    const handler = makeHandler({ warmTtlMs: 40, attachTtlMs: 5 });
    const sse = new SseReader(
      await handler.fetch(new Request(`${base}/__rpxd/stream?stream=s1`, { headers: COOKIE })),
    );
    const { instance } = (await (
      await control(handler, { type: "mount", path: "/chat", props: { tools: [] }, stream: "s1" })
    ).json()) as { instance: string };
    await sse.next(); // subscribed

    // Release arms the eviction timer (warmTtl 40ms)…
    await control(handler, { type: "release", instance, stream: "s1" });
    // …but a re-mount well within the TTL re-subscribes it, clearing the timer.
    await new Promise((r) => setTimeout(r, 10));
    await control(handler, { type: "mount", path: "/chat", props: { tools: [] }, stream: "s1" });

    // Past the original TTL: a naive timer would have evicted; the re-subscribe
    // must have cancelled it.
    await new Promise((r) => setTimeout(r, 60));
    expect(await alive(handler, instance)).toBe(true);
    expect(handler.instanceCount).toBe(1);
    await handler.dispose();
  });

  it("subscribeInstance is idempotent — a re-mount on the same stream never double-joins", async () => {
    const handler = makeHandler();
    const sse = new SseReader(
      await handler.fetch(new Request(`${base}/__rpxd/stream?stream=s1`, { headers: COOKIE })),
    );
    const { instance } = (await (
      await control(handler, {
        type: "mount",
        path: "/chat",
        props: { tools: ["x"] },
        stream: "s1",
      })
    ).json()) as { instance: string };
    await sse.fullMatching((s) => s.tools.length > 0);

    // Re-mount the SAME still-subscribed instance on the SAME stream (no release
    // between — the warm-reuse path). It must not double-join: a single rpc
    // mutation still produces exactly ONE patch envelope, not two.
    await control(handler, { type: "mount", path: "/chat", props: { tools: ["x"] }, stream: "s1" });
    await rpc(handler, instance, "once");
    const patches: Envelope[] = [];
    for (;;) {
      const env = await sse.next(200);
      if (!env) break;
      if (env.patches) patches.push(env);
    }
    const logPatches = patches.filter((e) =>
      e.patches?.some((p) => JSON.stringify(p.path).includes("log")),
    );
    expect(logPatches).toHaveLength(1); // one listener, one delivery
    await handler.dispose();
  });
});
