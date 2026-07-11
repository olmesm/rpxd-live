import type { Envelope, LiveDefinition, PROTOCOL_VERSION, RpxdDiagnostic } from "@rpxd/core";
import { describe, expect, it } from "vitest";
import type { SocketLike } from "../src/adapter.ts";
import { createRpxdHandler, DEFAULT_MAX_BUFFERED_BYTES } from "../src/handler.ts";
import { wsTransport } from "../src/ws.ts";

interface BoardState {
  items: string[];
}

const boardDef: LiveDefinition<BoardState, "/board", Record<string, unknown>> = {
  setup: () => ({ items: ["first"] }),
  rpc: {
    async add({ item }: { item: string }, ctx) {
      ctx.patchState((state) => {
        state.items.push(item);
      });
    },
  },
};

/** A route whose very first full snapshot already dwarfs a small budget. */
const blobDef: LiveDefinition<{ blob: string }, "/blob", Record<string, unknown>> = {
  setup: () => ({ blob: "x".repeat(5000) }),
};

const V = 1 as typeof PROTOCOL_VERSION;
const base = "http://test.local";
const COOKIE = { cookie: "rpxd_sid=egress-a" };

function makeHandler(overrides: Partial<Parameters<typeof createRpxdHandler>[0]> = {}) {
  return createRpxdHandler({
    routes: [
      { path: "/board", def: boardDef },
      { path: "/blob", def: blobDef },
    ],
    warmTtlMs: 15,
    attachTtlMs: 40,
    cookie: { sign: false }, // fixed literal cookie needs a stable, unsigned sid
    ...overrides,
  });
}

async function mount(handler: ReturnType<typeof makeHandler>, path = "/board") {
  const res = await handler.fetch(
    new Request(`${base}/__rpxd/control`, {
      method: "POST",
      headers: COOKIE,
      body: JSON.stringify({ type: "mount", path }),
    }),
  );
  const { instance } = await res.json();
  return instance as string;
}

function rpc(handler: ReturnType<typeof makeHandler>, instance: string, item: string, id = "r1") {
  return handler.fetch(
    new Request(`${base}/__rpxd/rpc`, {
      method: "POST",
      headers: COOKIE,
      body: JSON.stringify({
        v: V,
        instance,
        rpcId: id,
        calls: [{ rpc: "add", payload: { item } }],
      }),
    }),
  );
}

/** Incremental SSE parser over a streaming Response (as in handler.test.ts). */
class SseReader {
  #reader: ReadableStreamDefaultReader<Uint8Array>;
  #decoder = new TextDecoder();
  #buf = "";
  #queue: Envelope[] = [];

  constructor(res: Response) {
    this.#reader = (res.body as ReadableStream<Uint8Array>).getReader();
  }

  async next(timeoutMs = 700): Promise<Envelope | null> {
    const deadline = Date.now() + timeoutMs;
    while (this.#queue.length === 0) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return null;
      const result = await Promise.race([
        this.#reader.read(),
        new Promise<"timeout">((r) => setTimeout(() => r("timeout"), remaining)),
      ]);
      if (result === "timeout") return null;
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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("SSE egress byte budget — slow-consumer kill (§11)", () => {
  it("kills a stream whose unread buffer exceeds maxBufferedBytes and emits stream-overflow", async () => {
    const events: RpxdDiagnostic[] = [];
    const handler = makeHandler({ maxBufferedBytes: 512, onDiagnostic: (e) => events.push(e) });
    const instance = await mount(handler);
    // Open the stream but never read from it — a stalled client.
    const streamRes = await handler.fetch(
      new Request(`${base}/__rpxd/stream`, { headers: COOKIE }),
    );
    expect((await rpc(handler, instance, "y".repeat(2000))).status).toBe(202);
    await sleep(30); // let the ack flush land on the (unread) stream

    const overflow = events.find((e) => e.type === "stream-overflow");
    expect(overflow).toMatchObject({ category: "security", level: "warn" });
    // The stream was errored (buffer discarded), not left growing.
    const reader = (streamRes.body as ReadableStream<Uint8Array>).getReader();
    await expect(reader.read()).rejects.toThrow();
    await handler.dispose();
  });

  it("re-arms eviction for the killed stream's instances (listener detached)", async () => {
    const handler = makeHandler({
      maxBufferedBytes: 512,
      warmTtlMs: 80,
      attachTtlMs: 10,
    });
    const instance = await mount(handler);
    await handler.fetch(new Request(`${base}/__rpxd/stream`, { headers: COOKIE }));
    await rpc(handler, instance, "y".repeat(2000));
    await sleep(30); // overflow kill lands; instance rides the warm TTL now
    expect(handler.instanceCount).toBe(1);
    await sleep(200); // past warmTtlMs — a dangling listener would pin it forever
    expect(handler.instanceCount).toBe(0);
    await handler.dispose();
  });

  it("budgets the buffered bytes, not cumulative traffic — a reading client outlives it", async () => {
    const events: RpxdDiagnostic[] = [];
    const handler = makeHandler({ maxBufferedBytes: 512, onDiagnostic: (e) => events.push(e) });
    const instance = await mount(handler);
    const streamRes = await handler.fetch(
      new Request(`${base}/__rpxd/stream`, { headers: COOKIE }),
    );
    const sse = new SseReader(streamRes);
    expect((await sse.next())?.full).toBeDefined();
    // Push well over 512 bytes total, but drain each ack before the next rpc.
    for (let i = 0; i < 5; i++) {
      await rpc(handler, instance, `item-${i}-${"z".repeat(120)}`, `r${i}`);
      const ack = await sse.next();
      expect(ack?.rpcId).toBe(`r${i}`);
    }
    expect(events.find((e) => e.type === "stream-overflow")).toBeUndefined();
    await handler.dispose();
  });

  it("kills even when the very first snapshot overflows (pre-registration path)", async () => {
    const events: RpxdDiagnostic[] = [];
    const handler = makeHandler({
      maxBufferedBytes: 256,
      warmTtlMs: 15,
      attachTtlMs: 10,
      onDiagnostic: (e) => events.push(e),
    });
    await mount(handler, "/blob"); // 5 KB setup state ≫ 256-byte budget
    const streamRes = await handler.fetch(
      new Request(`${base}/__rpxd/stream`, { headers: COOKIE }),
    );
    expect(events.find((e) => e.type === "stream-overflow")).toBeDefined();
    const reader = (streamRes.body as ReadableStream<Uint8Array>).getReader();
    await expect(reader.read()).rejects.toThrow();
    // Cleanup ran despite the kill firing before stream registration.
    await sleep(120);
    expect(handler.instanceCount).toBe(0);
    await handler.dispose();
  });

  it("disables the budget when maxBufferedBytes is null", async () => {
    const events: RpxdDiagnostic[] = [];
    const handler = makeHandler({ maxBufferedBytes: null, onDiagnostic: (e) => events.push(e) });
    const instance = await mount(handler);
    const streamRes = await handler.fetch(
      new Request(`${base}/__rpxd/stream`, { headers: COOKIE }),
    );
    await rpc(handler, instance, "y".repeat(2000));
    await sleep(30);
    expect(events.find((e) => e.type === "stream-overflow")).toBeUndefined();
    // Buffered envelopes are all still readable — nothing was discarded.
    const sse = new SseReader(streamRes);
    expect((await sse.next())?.full).toBeDefined();
    expect((await sse.next())?.rpcId).toBe("r1");
    await handler.dispose();
  });

  it("defaults to DEFAULT_MAX_BUFFERED_BYTES (8 MiB) and reflects overrides", async () => {
    const dflt = makeHandler();
    expect(DEFAULT_MAX_BUFFERED_BYTES).toBe(8 * 1024 * 1024);
    expect(dflt.maxBufferedBytes).toBe(DEFAULT_MAX_BUFFERED_BYTES);
    const tuned = makeHandler({ maxBufferedBytes: 1024 });
    expect(tuned.maxBufferedBytes).toBe(1024);
    const off = makeHandler({ maxBufferedBytes: null });
    expect(off.maxBufferedBytes).toBeNull();
    await dflt.dispose();
    await tuned.dispose();
    await off.dispose();
  });
});

describe("WS egress byte budget — bufferedAmount kill (§11)", () => {
  interface FakeWsData {
    sid: string;
    sessionData: unknown;
    attach: { token: string | null; seq: number };
    session: unknown;
  }

  function fakeSocket(bufferedAmount?: () => number) {
    const sent: string[] = [];
    let closed = false;
    const socket: SocketLike<FakeWsData> = {
      data: { sid: "egress-a", sessionData: {}, attach: { token: null, seq: -1 }, session: null },
      send: (message: string) => {
        sent.push(message);
      },
      close: () => {
        closed = true;
      },
      ...(bufferedAmount ? { getBufferedAmount: bufferedAmount } : {}),
    };
    return { socket, sent, isClosed: () => closed };
  }

  it("closes a socket whose bufferedAmount exceeds the budget and emits stream-overflow", async () => {
    const events: RpxdDiagnostic[] = [];
    const handler = makeHandler({ maxBufferedBytes: 64, onDiagnostic: (e) => events.push(e) });
    const instance = await mount(handler);
    const ws = wsTransport(handler);
    const { socket, sent, isClosed } = fakeSocket(() => 100_000);
    ws.websocket.open?.(socket as SocketLike);

    expect(sent).toHaveLength(1); // the full snapshot went out before the kill
    expect(isClosed()).toBe(true);
    const overflow = events.find((e) => e.type === "stream-overflow");
    expect(overflow).toMatchObject({ category: "security", level: "warn" });
    expect(overflow?.detail).toMatchObject({ transport: "ws" });

    // A killed socket sends nothing further, even before the close round-trips.
    await handler.fetch(
      new Request(`${base}/__rpxd/control`, {
        method: "POST",
        headers: COOKIE,
        body: JSON.stringify({ type: "resync", instance }),
      }),
    );
    expect(sent).toHaveLength(1);
    await handler.dispose();
  });

  it("leaves a healthy socket alone", async () => {
    const events: RpxdDiagnostic[] = [];
    const handler = makeHandler({ maxBufferedBytes: 64, onDiagnostic: (e) => events.push(e) });
    await mount(handler);
    const ws = wsTransport(handler);
    const { socket, sent, isClosed } = fakeSocket(() => 0);
    ws.websocket.open?.(socket as SocketLike);
    expect(sent).toHaveLength(1);
    expect(isClosed()).toBe(false);
    expect(events.find((e) => e.type === "stream-overflow")).toBeUndefined();
    await handler.dispose();
  });

  it("skips enforcement when the adapter exposes no bufferedAmount", async () => {
    const handler = makeHandler({ maxBufferedBytes: 64 });
    await mount(handler);
    const ws = wsTransport(handler);
    const { socket, sent, isClosed } = fakeSocket(); // no getBufferedAmount
    ws.websocket.open?.(socket as SocketLike);
    expect(sent).toHaveLength(1);
    expect(isClosed()).toBe(false); // unmeasurable → unenforced, never a false kill
    await handler.dispose();
  });
});
