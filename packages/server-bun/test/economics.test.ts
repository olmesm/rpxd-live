/**
 * Session economics (ADR 0002 item 14, Decision 6 — "the cap is doctrine
 * enforcement"). The per-session instance cap stays 32; on top of it this pins
 * the two new soft guards and the doctrine-worded cap diagnostic:
 *
 * - **Byte budget** (`maxSessionStateBytes`, default disabled): a running sum of
 *   each held instance's serialized state size. Over budget → refuse a NEW mount
 *   (429 / WS error envelope) after trying to shed idle instances first — never
 *   reject a flush/rpc on an existing instance, never evict a subscribed one.
 * - **Mount throttle** (`mountRateLimit`, default ON): a per-session token bucket
 *   on `mount` / `mount-batch`, costed per entry so a batch can't bypass it.
 *   Exceeded → 429 / WS error envelope; existing instances are untouched.
 * - **Cap diagnostic**: a `cap-rejected` carries the cap value and the
 *   "Aggregates, not rows" doctrine hint.
 */
import type { Envelope, LiveDefinition, PROTOCOL_VERSION, RpxdDiagnostic } from "@rpxd/core";
import { describe, expect, it } from "vitest";
import { createRpxdHandler, DEFAULT_MOUNT_RATE_LIMIT } from "../src/handler.ts";

const base = "http://test.local";
const V = 1 as typeof PROTOCOL_VERSION;
const cookieOf = (sid: string) => ({ cookie: `rpxd_sid=${sid}` });

interface BigState {
  blob: string;
  pokes: number;
}

/** A route whose loader writes a ~4 KiB blob — one instance easily overruns a
 * small byte budget, and its `poke` rpc proves flushes still land under refusal. */
const BLOB_LEN = 4000;
const bigDef: LiveDefinition<BigState, "/big/$id", Record<string, unknown>> = {
  setup: () => ({ blob: "", pokes: 0 }),
  load: async (_arg, ctx) => {
    ctx.patchState((s) => {
      s.blob = "x".repeat(BLOB_LEN);
    });
  },
  rpc: {
    async poke(_p: unknown, ctx) {
      ctx.patchState((s) => {
        s.pokes += 1;
      });
    },
  },
};

/** A tiny slot for throttle tests — many distinct instances, negligible bytes. */
const cardDef: LiveDefinition<{ id: string }, "/card/$id", Record<string, unknown>> = {
  setup: (ctx) => ({ id: ctx.params.id }),
};

function makeHandler(overrides: Partial<Parameters<typeof createRpxdHandler>[0]> = {}) {
  return createRpxdHandler({
    routes: [],
    slots: [
      { path: "/big/$id", def: bigDef },
      { path: "/card/$id", def: cardDef },
    ],
    warmTtlMs: 1000,
    attachTtlMs: 1000,
    cookie: { sign: false },
    ...overrides,
  });
}

const control = (h: ReturnType<typeof makeHandler>, sid: string, body: unknown) =>
  h.fetch(
    new Request(`${base}/__rpxd/control`, {
      method: "POST",
      headers: cookieOf(sid),
      body: JSON.stringify(body),
    }),
  );

const mount = (h: ReturnType<typeof makeHandler>, sid: string, path: string, stream?: string) =>
  control(h, sid, { type: "mount", path, ...(stream ? { stream } : {}) });

const openStream = (
  h: ReturnType<typeof makeHandler>,
  sid: string,
  streamId: string,
  signal?: AbortSignal,
) =>
  h.fetch(
    new Request(`${base}/__rpxd/stream?stream=${streamId}`, { headers: cookieOf(sid), signal }),
  );

const rpc = (h: ReturnType<typeof makeHandler>, sid: string, instance: string, rpcName: string) =>
  h.fetch(
    new Request(`${base}/__rpxd/rpc`, {
      method: "POST",
      headers: cookieOf(sid),
      body: JSON.stringify({
        v: V,
        instance,
        rpcId: `r-${Math.random()}`,
        calls: [{ rpc: rpcName, payload: {} }],
      }),
    }),
  );

/** Incremental SSE parser over a streaming Response (mirrors mount-batch.test.ts). */
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

describe("byte budget (maxSessionStateBytes) — soft, mount-gate only", () => {
  it("refuses a NEW mount over budget while the existing instance's rpc still flushes", async () => {
    const diags: RpxdDiagnostic[] = [];
    const handler = makeHandler({ maxSessionStateBytes: 2000, onDiagnostic: (d) => diags.push(d) });
    const abort = new AbortController();
    const sse = new SseReader(await openStream(handler, "bud", "s1", abort.signal));

    // First big mount lands (session was empty, under budget), and now holds
    // ~4 KiB — the session is over the 2 KiB budget.
    const first = await mount(handler, "bud", "/big/1", "s1");
    expect(first.status).toBe(200);
    const firstId = ((await first.json()) as { instance: string }).instance;

    // A NEW mount is refused: /big/1 is subscribed to s1 (not idle-sheddable),
    // so shedding can't free bytes → 429 + the doctrine diagnostic.
    const refused = await mount(handler, "bud", "/big/2", "s1");
    expect(refused.status).toBe(429);
    expect(handler.instanceCount).toBe(1);
    const budgetDiag = diags.find((d) => d.type === "session-budget-exceeded");
    expect(budgetDiag).toMatchObject({
      category: "security",
      level: "warn",
      detail: { budget: 2000 },
    });
    expect((budgetDiag?.detail as { bytes: number }).bytes).toBeGreaterThan(2000);

    // The existing instance is untouched: its rpc runs and its patchState flush
    // lands (a soft budget never rejects a flush on a live instance).
    expect((await rpc(handler, "bud", firstId, "poke")).status).toBe(202);
    let landed = false;
    for (let i = 0; i < 8 && !landed; i++) {
      const env = await sse.next();
      if (env?.patches?.some((p) => JSON.stringify(p.path) === JSON.stringify(["pokes"]))) {
        landed = true;
      }
    }
    expect(landed).toBe(true);

    abort.abort();
    await handler.dispose();
  });

  it("frees budget when an idle instance is shed to make room (mirrors the cap path)", async () => {
    const handler = makeHandler({ maxSessionStateBytes: 2000 });
    // /big/1 is mounted but NEVER joined to a stream → idle (evictable).
    const idle = await mount(handler, "idle-bud", "/big/1");
    expect(idle.status).toBe(200);
    const idleId = ((await idle.json()) as { instance: string }).instance;

    // Over budget, but the big instance is idle → shed it, then admit the mount.
    const admitted = await mount(handler, "idle-bud", "/big/2");
    expect(admitted.status).toBe(200);
    expect(handler.instanceCount).toBe(1);
    // The idle big instance made room — it's gone (404 on an rpc probe).
    expect((await rpc(handler, "idle-bud", idleId, "poke")).status).toBe(404);
    await handler.dispose();
  });

  it("disabled by default — no refusals regardless of state size", async () => {
    const handler = makeHandler(); // no maxSessionStateBytes
    for (let i = 0; i < 5; i++) {
      expect((await mount(handler, "nobud", `/big/${i}`)).status).toBe(200);
    }
    expect(handler.instanceCount).toBe(5);
    await handler.dispose();
  });

  it("surfaces the budget refusal as a WS error envelope", async () => {
    const handler = makeHandler({ maxSessionStateBytes: 2000 });
    const sent: Envelope[] = [];
    const sock = handler.socket("ws-bud", {}, (env) => sent.push(env));
    await sock.message(JSON.stringify({ type: "mount", path: "/big/1" }));
    expect(handler.instanceCount).toBe(1);
    // /big/1 is subscribed (the socket IS its stream) → can't shed → refuse.
    await sock.message(JSON.stringify({ type: "mount", path: "/big/2" }));
    expect(sent.find((e) => e.error)?.error?.name).toBe("SessionBudgetError");
    expect(handler.instanceCount).toBe(1);
    sock.close();
    await handler.dispose();
  });
});

describe("mount throttle (mountRateLimit) — per-session token bucket, per-entry cost", () => {
  it("429s a mount loop past the bucket; existing instances keep working", async () => {
    const diags: RpxdDiagnostic[] = [];
    const handler = makeHandler({
      mountRateLimit: { capacity: 3, refillPerSec: 0 },
      onDiagnostic: (d) => diags.push(d),
    });
    const abort = new AbortController();
    await openStream(handler, "thr", "s1", abort.signal);
    const first = await mount(handler, "thr", "/card/0", "s1");
    expect(first.status).toBe(200);
    const firstId = ((await first.json()) as { instance: string }).instance;
    expect((await mount(handler, "thr", "/card/1", "s1")).status).toBe(200);
    expect((await mount(handler, "thr", "/card/2", "s1")).status).toBe(200);
    // Bucket drained (capacity 3, no refill) → the 4th mount is throttled.
    const throttled = await mount(handler, "thr", "/card/3", "s1");
    expect(throttled.status).toBe(429);
    expect(diags.map((d) => d.type)).toContain("mount-throttled");
    // An rpc on an existing instance is never gated by the mount throttle — the
    // transport accepts it (202) even while every fresh mount is being refused.
    expect((await rpc(handler, "thr", firstId, "poke")).status).toBe(202);
    // ...and the bucket stays drained: a further mount is still throttled.
    expect((await mount(handler, "thr", "/card/0", "s1")).status).toBe(429);
    abort.abort();
    await handler.dispose();
  });

  it("costs a mount-batch per entry (a batch can't bypass the bucket)", async () => {
    const handler = makeHandler({ mountRateLimit: { capacity: 5, refillPerSec: 0 } });
    const batch5 = await control(handler, "batch-thr", {
      type: "mount-batch",
      mounts: Array.from({ length: 5 }, (_, i) => ({ path: `/card/${i}`, props: {} })),
    });
    expect(batch5.status).toBe(200);
    expect(handler.instanceCount).toBe(5);
    // Bucket fully drained by the 5-entry batch — a single further mount 429s.
    expect((await mount(handler, "batch-thr", "/card/99")).status).toBe(429);
    await handler.dispose();
  });

  it("rejects a batch wholesale (nothing mounted) when it exceeds the bucket", async () => {
    const handler = makeHandler({ mountRateLimit: { capacity: 3, refillPerSec: 0 } });
    const res = await control(handler, "over-batch", {
      type: "mount-batch",
      mounts: Array.from({ length: 4 }, (_, i) => ({ path: `/card/${i}`, props: {} })),
    });
    expect(res.status).toBe(429);
    expect(handler.instanceCount).toBe(0); // atomic: no entry mounted
    await handler.dispose();
  });

  it("the generous default doesn't trip on a realistic nav (10 sequential remounts pass)", async () => {
    expect(DEFAULT_MOUNT_RATE_LIMIT.capacity).toBeGreaterThanOrEqual(32);
    const handler = makeHandler(); // default mountRateLimit ON
    for (let i = 0; i < 10; i++) {
      expect((await mount(handler, "nav", `/card/${i}`)).status).toBe(200);
    }
    await handler.dispose();
  });

  it("surfaces the throttle refusal as a WS error envelope", async () => {
    const handler = makeHandler({ mountRateLimit: { capacity: 1, refillPerSec: 0 } });
    const sent: Envelope[] = [];
    const sock = handler.socket("ws-thr", {}, (env) => sent.push(env));
    await sock.message(JSON.stringify({ type: "mount", path: "/card/0" }));
    expect(handler.instanceCount).toBe(1);
    await sock.message(JSON.stringify({ type: "mount", path: "/card/1", mountId: "m2" }));
    const err = sent.find((e) => e.error);
    expect(err?.error?.name).toBe("MountThrottleError");
    expect(err?.mountId).toBe("m2");
    expect(handler.instanceCount).toBe(1);
    sock.close();
    await handler.dispose();
  });

  it("null disables the throttle", async () => {
    const handler = makeHandler({ mountRateLimit: null });
    for (let i = 0; i < 40; i++) {
      expect((await mount(handler, "no-thr", `/card/${i}`)).status).toBe(200);
    }
    await handler.dispose();
  });
});

describe("cap diagnostic carries the doctrine wording", () => {
  it("emits cap-rejected with the cap value and the 'Aggregates, not rows' hint", async () => {
    const boardDef: LiveDefinition<{ n: number }, "/n/$id", Record<string, unknown>> = {
      setup: () => ({ n: 1 }),
    };
    const diags: RpxdDiagnostic[] = [];
    const handler = createRpxdHandler({
      routes: [],
      slots: [{ path: "/n/$id", def: boardDef }],
      maxInstancesPerSession: 1,
      warmTtlMs: 1000,
      attachTtlMs: 1000,
      cookie: { sign: false },
      onDiagnostic: (d) => diags.push(d),
    });
    const abort = new AbortController();
    await openStream(handler as never, "cap", "s1", abort.signal);
    await control(handler, "cap", { type: "mount", path: "/n/1", stream: "s1" });
    await control(handler, "cap", { type: "mount", path: "/n/2", stream: "s1" });
    const capDiag = diags.find((d) => d.type === "cap-rejected");
    expect(capDiag).toMatchObject({ category: "security", detail: { cap: 1 } });
    expect(String((capDiag?.detail as { hint: string }).hint)).toContain("Aggregates, not rows");
    abort.abort();
    await handler.dispose();
  });
});
