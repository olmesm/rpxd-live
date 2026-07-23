/**
 * Batched slot mounts + the fan-out doctrine diagnostic (ADR 0002 item 11): N
 * same-tick `mountSlot` calls coalesce into ONE `mount-batch` control POST. The
 * server runs the EXACT single-mount path per entry (via `mountOne`) and answers
 * POSITIONALLY — `results[i]` for `mounts[i]`. These pin: N valid mounts →
 * N instances joined to the stream, order preserved; a mixed valid/invalid/deny
 * batch settles each entry independently (one failure never poisons siblings);
 * the dev-only `slot-fanout-high` diagnostic fires past the advice threshold and
 * NEVER in production; and an over-cap batch is rejected 4xx with nothing built.
 */
import { type Envelope, type LiveDefinition, type RpxdDiagnostic, redirect } from "@rpxd/core";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { createRpxdHandler, MAX_MOUNT_BATCH, SLOT_FANOUT_ADVICE } from "../src/handler.ts";

const base = "http://test.local";
const COOKIE = { cookie: "rpxd_sid=session-a" };

// A parameterized slot: `/card/$id` — one instance per id, so a batch can mount
// many DISTINCT instances (not warm-reuse of one path).
const cardDef: LiveDefinition<{ id: string }, "/card/$id", Record<string, unknown>> = {
  setup: (ctx) => ({ id: ctx.params.id }),
};

// A schema'd slot: proves an invalid-props entry answers `{ error }` positionally
// while its siblings still mount.
let chatSetup = 0;
const chatSchema = z.object({ tools: z.array(z.string()) });
const chatDef: LiveDefinition<
  { tools: string[] },
  "/chat",
  Record<string, unknown>,
  { tools: string[] }
> = {
  setup: () => {
    chatSetup++;
    return { tools: [] as string[] };
  },
  load: async ({ props }, ctx) => {
    ctx.patchState((s) => {
      s.tools = props.tools;
    });
  },
};

// A slot whose guard denies — answers `{ redirect }`, allocates nothing.
const deniedDef: LiveDefinition<{ ok: boolean }, "/secret", Record<string, unknown>> = {
  setup: () => ({ ok: true }),
  guard: () => {
    throw redirect("/login");
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
}

function makeHandler(overrides: Partial<Parameters<typeof createRpxdHandler>[0]> = {}) {
  chatSetup = 0;
  return createRpxdHandler({
    routes: [],
    slots: [
      { path: "/card/$id", def: cardDef },
      { path: "/chat", def: chatDef, props: chatSchema },
      { path: "/secret", def: deniedDef },
    ],
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

const cards = (n: number, from = 0) =>
  Array.from({ length: n }, (_, i) => ({ path: `/card/${from + i}`, props: {} }));

const originalNodeEnv = process.env.NODE_ENV;
afterEach(() => {
  if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = originalNodeEnv;
});

describe("batched slot mounts (ADR 0002 item 11)", () => {
  it("mounts N valid entries, joins each to the stream, and answers positionally", async () => {
    const handler = makeHandler();
    const sse = new SseReader(
      await handler.fetch(new Request(`${base}/__rpxd/stream?stream=s1`, { headers: COOKIE })),
    );
    const res = await control(handler, { type: "mount-batch", stream: "s1", mounts: cards(5) });
    expect(res.status).toBe(200);
    const { results } = (await res.json()) as {
      results: { instance: string; params: { id: string } }[];
    };
    // Positional: results[i] answers mounts[i], in order.
    expect(results.map((r) => r.params.id)).toEqual(["0", "1", "2", "3", "4"]);
    expect(new Set(results.map((r) => r.instance)).size).toBe(5); // distinct instances
    expect(handler.instanceCount).toBe(5);

    // Envelopes flow: every mounted instance's snapshot arrives on the stream.
    const seen = new Set<string>();
    for (let i = 0; i < 5; i++) {
      const env = await sse.next();
      if (env?.full) seen.add((env.full.state as { id: string }).id);
    }
    expect(seen).toEqual(new Set(["0", "1", "2", "3", "4"]));
    await handler.dispose();
  });

  it("settles a mixed valid / invalid-props / guard-deny batch independently", async () => {
    const handler = makeHandler();
    const res = await control(handler, {
      type: "mount-batch",
      mounts: [
        { path: "/card/1", props: {} }, // valid
        { path: "/chat", props: { tools: 5 } }, // invalid props → error
        { path: "/secret", props: {} }, // guard deny → redirect
      ],
    });
    expect(res.status).toBe(200);
    const { results } = (await res.json()) as {
      results: (
        | { instance: string; params: { id: string } }
        | { error: { name: string } }
        | { redirect: string }
      )[];
    };
    expect(results[0] && "instance" in results[0]).toBe(true);
    expect((results[0] as { params: { id: string } }).params.id).toBe("1");
    expect((results[1] as { error: { name: string } }).error.name).toBe("ValidationError");
    expect((results[2] as { redirect: string }).redirect).toBe("/login");
    // Only the valid entry mounted; the invalid one never ran setup.
    expect(handler.instanceCount).toBe(1);
    expect(chatSetup).toBe(0);
    await handler.dispose();
  });

  it("a malformed entry answers `{ error }` without poisoning its siblings", async () => {
    const handler = makeHandler();
    const res = await control(handler, {
      type: "mount-batch",
      mounts: [{ path: "/card/7", props: {} }, { nope: true }],
    });
    const { results } = (await res.json()) as {
      results: ({ instance: string } | { error: { name: string } })[];
    };
    expect(results[0] && "instance" in results[0]).toBe(true);
    expect((results[1] as { error: { name: string } }).error.name).toBe("ProtocolError");
    expect(handler.instanceCount).toBe(1);
    await handler.dispose();
  });

  it("emits exactly one `slot-fanout-high` diagnostic in dev past the advice threshold", async () => {
    process.env.NODE_ENV = "development";
    const diags: RpxdDiagnostic[] = [];
    const handler = makeHandler({ onDiagnostic: (d) => diags.push(d) });
    const n = SLOT_FANOUT_ADVICE + 1; // 11 — the first count that trips the nudge
    const res = await control(handler, { type: "mount-batch", mounts: cards(n) });
    expect(res.status).toBe(200);
    const fanout = diags.filter((d) => d.type === "slot-fanout-high");
    expect(fanout).toHaveLength(1);
    expect(fanout[0]).toMatchObject({ category: "instance", level: "warn", detail: { count: n } });
    await handler.dispose();
  });

  it("does NOT emit the diagnostic for a batch at the advice threshold (dev)", async () => {
    process.env.NODE_ENV = "development";
    const diags: RpxdDiagnostic[] = [];
    const handler = makeHandler({ onDiagnostic: (d) => diags.push(d) });
    await control(handler, { type: "mount-batch", mounts: cards(SLOT_FANOUT_ADVICE) }); // exactly 10
    expect(diags.filter((d) => d.type === "slot-fanout-high")).toHaveLength(0);
    await handler.dispose();
  });

  it("NEVER emits the diagnostic in production (isDev gate)", async () => {
    process.env.NODE_ENV = "production";
    const diags: RpxdDiagnostic[] = [];
    const handler = makeHandler({ onDiagnostic: (d) => diags.push(d) });
    await control(handler, { type: "mount-batch", mounts: cards(SLOT_FANOUT_ADVICE + 1) });
    expect(diags.filter((d) => d.type === "slot-fanout-high")).toHaveLength(0);
    await handler.dispose();
  });

  it("rejects a batch over the sanity cap with 413, mounting nothing", async () => {
    const handler = makeHandler();
    const res = await control(handler, {
      type: "mount-batch",
      mounts: cards(MAX_MOUNT_BATCH + 1),
    });
    expect(res.status).toBe(413);
    expect(handler.instanceCount).toBe(0);
    await handler.dispose();
  });

  it("rejects a mount-batch whose `mounts` is not an array with 400", async () => {
    const handler = makeHandler();
    const res = await control(handler, { type: "mount-batch", mounts: "nope" });
    expect(res.status).toBe(400);
    expect(handler.instanceCount).toBe(0);
    await handler.dispose();
  });
});
