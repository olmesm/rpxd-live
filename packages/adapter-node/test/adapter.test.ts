/**
 * Runs under Vitest (Node lane) — exercises the real `node:http` adapter
 * end-to-end (the ServerAdapter seam on Node, §14). The rpxd runtime handler
 * is web-standard, so the same `createRpxdHandler` served by `bunAdapter`
 * serves here through `node:http` bytes.
 */

import type { LiveDefinition } from "@rpxd/core";
import { createRpxdHandler, wsTransport } from "@rpxd/server-bun";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { nodeAdapter } from "../src/index.ts";

const def: LiveDefinition<{ n: number }, "/", Record<string, unknown>> = {
  mount: async () => ({ n: 1 }),
};

describe("nodeAdapter", () => {
  const cleanups: Array<() => Promise<void> | void> = [];
  afterEach(async () => {
    for (const c of cleanups.splice(0)) await c();
  });

  it("serves the rpxd handler over real HTTP", async () => {
    const handler = createRpxdHandler({ routes: [{ path: "/", def }], warmTtlMs: 10 });
    const handle = nodeAdapter().serve({ port: 0, fetch: handler.fetch });
    cleanups.push(
      () => handler.dispose(),
      () => handle.stop(),
    );
    await handle.ready;

    const res = await fetch(`http://localhost:${handle.port}/`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('"state":{"n":1}');
    expect(res.headers.get("set-cookie")).toContain("rpxd_sid=");
  });

  it("streams SSE envelopes", async () => {
    const handler = createRpxdHandler({ routes: [{ path: "/", def }], warmTtlMs: 10 });
    const handle = nodeAdapter().serve({ port: 0, fetch: handler.fetch });
    cleanups.push(
      () => handler.dispose(),
      () => handle.stop(),
    );
    await handle.ready;

    const ctrl = new AbortController();
    const res = await fetch(`http://localhost:${handle.port}/__rpxd/stream`, {
      signal: ctrl.signal,
    });
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    if (!res.body) throw new Error("no SSE body");
    const reader = res.body.getReader();
    const { value } = await reader.read();
    expect(new TextDecoder().decode(value)).toContain("retry:");
    ctrl.abort();
    await reader.cancel().catch(() => {});
  });

  it("reads env through the seam", () => {
    process.env.RPXD_NODE_TEST_ENV = "yes";
    expect(nodeAdapter().env("RPXD_NODE_TEST_ENV")).toBe("yes");
  });

  it("upgrades a websocket and delivers the initial envelope", async () => {
    const handler = createRpxdHandler({ routes: [{ path: "/", def }], warmTtlMs: 10 });
    const ws = wsTransport(handler);
    const handle = nodeAdapter().serve({
      port: 0,
      websocket: ws.websocket,
      fetch: async (req, upgrade) => (await ws.handleUpgrade(req, upgrade)) ?? handler.fetch(req),
    });
    cleanups.push(
      () => handler.dispose(),
      () => handle.stop(),
    );
    await handle.ready;

    // Mount an instance under a fixed session so the socket, opened with the
    // same sid cookie, has something to sync on open.
    const cookie = "rpxd_sid=node-ws-session";
    await fetch(`http://localhost:${handle.port}/`, { headers: { cookie } });

    const socket = new WebSocket(`ws://localhost:${handle.port}/__rpxd/ws`, {
      headers: { cookie },
    });
    const firstMessage = await new Promise<string>((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => rejectPromise(new Error("no ws message")), 2000);
      socket.on("message", (raw) => {
        clearTimeout(timer);
        resolvePromise(String(raw));
      });
      socket.on("error", (e) => {
        clearTimeout(timer);
        rejectPromise(e);
      });
    });
    expect(firstMessage).toContain('"seq"');
    socket.close();
  });
});
