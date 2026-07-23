/**
 * WS transport (§11 opt-in) under `bun test`: real Bun.serve, real
 * WebSocket client, same protocol as SSE — only framing differs.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { Envelope, LiveDefinition, RpxdDiagnostic } from "@rpxd/core";
import { bunAdapter, type ServeHandle } from "../src/adapter.ts";
import { createRpxdHandler } from "../src/handler.ts";
import { wsTransport } from "../src/ws.ts";

interface S {
  items: string[];
  filter?: string;
}
const def: LiveDefinition<S, "/", { filter?: string }> = {
  setup: () => ({ items: ["first"] }),
  load: async ({ props }, ctx) => {
    ctx.patchState((s) => {
      s.filter = props.filter ?? "all";
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
  // fixed literal cookies throughout this file need a stable, unsigned sid.
  handler = createRpxdHandler({
    routes: [{ path: "/", def }],
    warmTtlMs: 50,
    cookie: { sign: false },
  });
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

function openSocket(
  cookie: string = COOKIE,
  port: number = handle.port,
): Promise<{ socket: WebSocket; next(timeoutMs?: number): Promise<Envelope> }> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://localhost:${port}/__rpxd/ws`, {
      // Bun extension: pass the session cookie on the upgrade request
      headers: { cookie },
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
    socket.send(JSON.stringify({ type: "url", instance, props: { filter: "done" } }));
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

describe("guarded batch-dispatch boundary (channel pipeline increment 2, #110/#65)", () => {
  it("keeps the socket alive on a malformed `calls` batch and error-acks it", async () => {
    const cookie = "rpxd_sid=ws-malformed-calls";
    const mountRes = await fetch(`http://localhost:${handle.port}/__rpxd/control`, {
      method: "POST",
      headers: { cookie },
      body: JSON.stringify({ type: "mount", path: "/" }),
    });
    const { instance } = await mountRes.json();

    const { socket, next } = await openSocket(cookie);
    await next(); // full snapshot from the mount above

    socket.send(JSON.stringify({ v: 1, instance, rpcId: "c1", calls: null }));
    const ack = await next();
    expect(ack.rpcId).toBe("c1");
    expect(ack.error?.name).toBe("ProtocolError");

    // The socket is still alive — a following valid frame still works.
    socket.send(
      JSON.stringify({
        v: 1,
        instance,
        rpcId: "c2",
        calls: [{ rpc: "add", payload: { item: "still-alive" } }],
      }),
    );
    const ok = await next();
    expect(ok.rpcId).toBe("c2");
    expect(ok.patches?.[0]?.value).toBe("still-alive");

    socket.close();
  });

  it("keeps the socket alive on an unparseable JSON frame and reports it via the diagnostic sink", async () => {
    // A dedicated handler+server (not the shared `beforeAll` one) so the
    // parse failure's diagnostic can be captured — the point of this test is
    // that `message()` itself reports `reason: "unparseable-frame"` rather
    // than relying on ws.ts's generic transport catch (which logs but tells
    // the client nothing and carries no `reason`).
    const events: RpxdDiagnostic[] = [];
    const localHandler = createRpxdHandler({
      routes: [{ path: "/", def }],
      onDiagnostic: (e) => events.push(e),
      cookie: { sign: false },
    });
    const localWs = wsTransport(localHandler);
    const local = bunAdapter().serve({
      port: 0,
      websocket: localWs.websocket,
      fetch: async (req, upgrade) => {
        const upgraded = await localWs.handleUpgrade(req, upgrade);
        if (upgraded) return upgraded.status === 101 ? undefined : upgraded;
        return localHandler.fetch(req);
      },
    });
    try {
      const cookie = "rpxd_sid=ws-unparseable-frame";
      const mountRes = await fetch(`http://localhost:${local.port}/__rpxd/control`, {
        method: "POST",
        headers: { cookie },
        body: JSON.stringify({ type: "mount", path: "/" }),
      });
      const { instance } = await mountRes.json();

      const { socket, next } = await openSocket(cookie, local.port);
      await next(); // full snapshot from the mount above

      socket.send("{"); // unparseable JSON frame

      // The socket is still alive — a following valid frame still works.
      socket.send(
        JSON.stringify({
          v: 1,
          instance,
          rpcId: "still-ok",
          calls: [{ rpc: "add", payload: { item: "after-garbage" } }],
        }),
      );
      const ok = await next();
      expect(ok.rpcId).toBe("still-ok");
      expect(ok.patches?.[0]?.value).toBe("after-garbage");

      const failed = events.find((e) => e.type === "ws-message-failed");
      expect(failed).toMatchObject({ category: "request", level: "warn" });
      expect(failed?.detail).toMatchObject({ reason: "unparseable-frame" });

      socket.close();
    } finally {
      await localHandler.dispose();
      await local.stop();
    }
  });

  it("answers a WS mount of an unregistered path with an error envelope (#65 WS mount parity)", async () => {
    const cookie = "rpxd_sid=ws-mount-404";
    const { socket, next } = await openSocket(cookie);

    socket.send(JSON.stringify({ type: "mount", path: "/definitely-not-registered" }));
    const env = await next();
    expect(env.error?.name).toBe("NotFoundError");

    socket.close();
  });
});
