/**
 * WS transport (§11 opt-in) under `bun test`: real Bun.serve, real
 * WebSocket client, same protocol as SSE — only framing differs.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { Envelope, LiveDefinition } from "@rpxd/core";
import { bunAdapter, type ServeHandle } from "../src/adapter.ts";
import { createRpxdHandler } from "../src/handler.ts";
import { wsTransport } from "../src/ws.ts";

interface S {
  items: string[];
  filter?: string;
}
const def: LiveDefinition<S, "/", { filter?: string }> = {
  setup: () => ({ items: ["first"] }),
  load: async ({ search }, ctx) => {
    ctx.patchState((s) => {
      s.filter = search.filter ?? "all";
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

let handler: ReturnType<typeof createRpxdHandler>;
let handle: ServeHandle;
const COOKIE = "rpxd_sid=ws-session";

beforeAll(() => {
  handler = createRpxdHandler({ routes: [{ path: "/", def }], warmTtlMs: 50 });
  const ws = wsTransport(handler);
  handle = bunAdapter().serve({
    port: 0,
    websocket: ws.websocket,
    fetch: async (req, upgrade) => {
      const upgraded = await ws.handleUpgrade(req, upgrade);
      if (upgraded) return upgraded.status === 101 ? undefined : upgraded;
      return handler.fetch(req);
    },
  });
});

afterAll(async () => {
  await handler.dispose();
  await handle.stop();
});

function openSocket(): Promise<{ socket: WebSocket; next(timeoutMs?: number): Promise<Envelope> }> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://localhost:${handle.port}/__rpxd/ws`, {
      // Bun extension: pass the session cookie on the upgrade request
      headers: { cookie: COOKIE },
    } as unknown as string[]);
    const queue: Envelope[] = [];
    const waiters: ((env: Envelope) => void)[] = [];
    socket.addEventListener("message", (event) => {
      const env = JSON.parse(String(event.data)) as Envelope;
      const waiter = waiters.shift();
      if (waiter) waiter(env);
      else queue.push(env);
    });
    socket.addEventListener("open", () =>
      resolve({
        socket,
        next: (timeoutMs = 2000) =>
          new Promise<Envelope>((res, rej) => {
            const queued = queue.shift();
            if (queued) return res(queued);
            const timer = setTimeout(() => rej(new Error("ws envelope timeout")), timeoutMs);
            waiters.push((env) => {
              clearTimeout(timer);
              res(env);
            });
          }),
      }),
    );
    socket.addEventListener("error", reject);
  });
}

describe("ws upgrade origin gate (#52)", () => {
  const noop = () => true;
  const target = "ws://localhost/__rpxd/ws";

  it("rejects a cross-origin upgrade with 403", async () => {
    const ws = wsTransport(handler);
    const res = await ws.handleUpgrade(
      new Request(target, { headers: { origin: "http://evil.example" } }),
      noop,
    );
    expect(res?.status).toBe(403);
  });

  it("allows same-origin and Origin-less upgrades", async () => {
    const ws = wsTransport(handler);
    const same = await ws.handleUpgrade(
      new Request(target, { headers: { origin: "http://localhost", host: "localhost" } }),
      noop,
    );
    expect(same?.status).toBe(101);
    const none = await ws.handleUpgrade(new Request(target), noop);
    expect(none?.status).toBe(101);
  });

  it("honors an allowlist for a cross-origin upgrade", async () => {
    const guarded = createRpxdHandler({
      routes: [{ path: "/", def }],
      allowedOrigins: ["http://trusted.example"],
    });
    const ws = wsTransport(guarded);
    const ok = await ws.handleUpgrade(
      new Request(target, { headers: { origin: "http://trusted.example" } }),
      noop,
    );
    expect(ok?.status).toBe(101);
    const blocked = await ws.handleUpgrade(
      new Request(target, { headers: { origin: "http://evil.example" } }),
      noop,
    );
    expect(blocked?.status).toBe(403);
    await guarded.dispose();
  });
});

describe("ws transport (§11)", () => {
  it("carries the full protocol over one duplex socket", async () => {
    // mount over HTTP (shared with SSE mode), then attach the socket
    const mountRes = await fetch(`http://localhost:${handle.port}/__rpxd/control`, {
      method: "POST",
      headers: { cookie: COOKIE },
      body: JSON.stringify({ type: "mount", path: "/" }),
    });
    const { instance } = await mountRes.json();

    const { socket, next } = await openSocket();
    const full = await next();
    expect(full.full).toBeDefined(); // snapshot on subscribe, same as SSE

    // rpc batch upstream on the same socket → ack envelope downstream
    socket.send(
      JSON.stringify({
        v: 1,
        instance,
        rpcId: "ws-1",
        calls: [{ rpc: "add", payload: { item: "over-ws" } }],
      }),
    );
    const ack = await next();
    expect(ack.rpcId).toBe("ws-1");
    expect(ack.patches?.[0]?.value).toBe("over-ws");

    // control messages ride the socket too — the `load` loader writes page
    // state (§7), so the patch lands on the page, not the $session slice
    socket.send(JSON.stringify({ type: "url", instance, search: { filter: "done" } }));
    const paramsEnv = await next();
    expect(paramsEnv.patches?.[0]?.path).toEqual(["filter"]);
    expect(paramsEnv.patches?.[0]?.value).toBe("done");

    socket.send(JSON.stringify({ type: "resync", instance }));
    const resynced = await next();
    expect(resynced.full).toBeDefined();
    expect((resynced.full?.state as S).items).toContain("over-ws");

    socket.close();
  });
});
