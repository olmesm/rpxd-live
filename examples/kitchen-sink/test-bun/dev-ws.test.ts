/**
 * Dev-mode WS transport (§11, dev/prod parity): `rpxd dev` serves
 * `/__rpxd/ws` on the same port as Vite (whose HMR socket must keep
 * working), speaking the same envelope protocol as the Bun.serve path.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { fileURLToPath } from "node:url";
import { createDevServer, type DevServer } from "@rpxd/cli";
import type { Envelope } from "@rpxd/core";

const root = fileURLToPath(new URL("..", import.meta.url));
const COOKIE = "rpxd_sid=dev-ws-session";

let server: DevServer;

beforeAll(async () => {
  // S1: signing is on by default (an ephemeral per-instance secret in dev),
  // which would reject the fixed literal `COOKIE` above as forged on every
  // request. This suite is about the WS transport, not cookie signing, so
  // opt into the explicit unsigned escape hatch. `configOverride` shallow-merges
  // `session`, so this also replaces kitchen-sink's own `session.authenticate` —
  // reinstate a minimal one (just `sid`, no real auth backend) since the todos
  // domain layer scopes rows by `ctx.session.sid` (see domain/scope.ts).
  server = await createDevServer(root, {
    port: 0,
    configOverride: {
      session: { authenticate: (_req, { sid }) => ({ sid }), cookie: { sign: false } },
    },
  });
});

afterAll(async () => {
  await server.close();
});

function openSocket(): Promise<{ socket: WebSocket; next(timeoutMs?: number): Promise<Envelope> }> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://localhost:${server.port}/__rpxd/ws`, {
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
        next: (timeoutMs = 3000) =>
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

describe("dev-mode ws transport (§11)", () => {
  it("carries the full protocol over one duplex socket on the dev port", async () => {
    // mount over HTTP control (shared with SSE mode), then attach the socket
    const mountRes = await fetch(`http://localhost:${server.port}/__rpxd/control`, {
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
        rpcId: "dev-ws-1",
        calls: [{ rpc: "add", payload: { text: "over-dev-ws" } }],
      }),
    );
    const ack = await next();
    expect(ack.rpcId).toBe("dev-ws-1");
    expect(
      ack.patches?.some((p) => (p.value as { text?: string } | undefined)?.text === "over-dev-ws"),
    ).toBe(true);

    socket.send(JSON.stringify({ type: "resync", instance }));
    const resynced = await next();
    expect(resynced.full).toBeDefined();

    socket.close();
  });

  it("leaves non-rpxd upgrades (Vite HMR) alone", async () => {
    // Vite's HMR websocket handshakes with the vite-hmr subprotocol on "/".
    const hmr = await new Promise<WebSocket>((resolve, reject) => {
      const ws = new WebSocket(`ws://localhost:${server.port}/`, "vite-hmr");
      ws.addEventListener("open", () => resolve(ws));
      ws.addEventListener("error", (e) => reject(e));
    });
    expect(hmr.readyState).toBe(WebSocket.OPEN);
    hmr.close();
  });
});
