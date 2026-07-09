/**
 * Runs under Vitest (Node lane) — exercises the real `node:http` adapter
 * end-to-end (the ServerAdapter seam on Node, §14). The rpxd runtime handler
 * is web-standard, so the same `createRpxdHandler` served by `bunAdapter`
 * serves here through `node:http` bytes.
 */

import { EventEmitter } from "node:events";
import type { ServerResponse } from "node:http";
import net from "node:net";
import type { LiveDefinition } from "@rpxd/core";
import { createRpxdHandler, wsTransport } from "@rpxd/server-bun";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { nodeAdapter, writeChunk } from "../src/index.ts";

describe("writeChunk backpressure", () => {
  it("resolves immediately when the socket accepts the write", async () => {
    const res = Object.assign(new EventEmitter(), {
      write: () => true,
    }) as unknown as ServerResponse;
    await writeChunk(res, new Uint8Array([1])); // must not hang
  });

  it("waits for 'drain' when the socket signals backpressure", async () => {
    const res = Object.assign(new EventEmitter(), {
      write: () => false,
    }) as unknown as ServerResponse;
    let resolved = false;
    const p = writeChunk(res, new Uint8Array([1])).then(() => {
      resolved = true;
    });
    await Promise.resolve();
    expect(resolved).toBe(false); // parked on backpressure, not spinning
    res.emit("drain");
    await p;
    expect(resolved).toBe(true);
  });

  it("stops waiting if the client goes away ('close')", async () => {
    const res = Object.assign(new EventEmitter(), {
      write: () => false,
    }) as unknown as ServerResponse;
    const p = writeChunk(res, new Uint8Array([1]));
    res.emit("close");
    await p; // resolves instead of leaking forever
  });
});

/** Speak one raw HTTP request over a socket (fetch() forbids invalid Host headers). */
function rawRequest(port: number, lines: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, "localhost", () => {
      socket.write(`${lines.join("\r\n")}\r\n\r\n`);
    });
    let buf = "";
    socket.on("data", (d) => {
      buf += d.toString();
    });
    socket.on("end", () => resolve(buf));
    socket.on("close", () => resolve(buf));
    socket.on("error", reject);
    setTimeout(() => {
      socket.destroy();
      resolve(buf);
    }, 2000);
  });
}

const def: LiveDefinition<{ n: number }, "/", Record<string, unknown>> = {
  setup: () => ({ n: 1 }),
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

  it("answers 400 to a malformed Host header instead of crashing the process", async () => {
    const handler = createRpxdHandler({ routes: [{ path: "/", def }], warmTtlMs: 10 });
    const handle = nodeAdapter().serve({ port: 0, fetch: handler.fetch });
    cleanups.push(
      () => handler.dispose(),
      () => handle.stop(),
    );
    await handle.ready;

    // A space makes the authority invalid, so `new Request()` would throw; Node's
    // header parser still passes it through to our handler.
    const raw = await rawRequest(handle.port, [
      "GET / HTTP/1.1",
      "Host: exa mple.com",
      "Connection: close",
    ]);
    expect(raw).toMatch(/^HTTP\/1\.1 400/);

    // The server must still be alive for a well-formed request.
    const res = await fetch(`http://localhost:${handle.port}/`);
    expect(res.status).toBe(200);
  });

  it("rejects a malformed Host on the ws upgrade path without crashing", async () => {
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

    await rawRequest(handle.port, [
      "GET /__rpxd/ws HTTP/1.1",
      "Host: exa mple.com",
      "Upgrade: websocket",
      "Connection: Upgrade",
      "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
      "Sec-WebSocket-Version: 13",
    ]);

    // The server survived the bad upgrade.
    const res = await fetch(`http://localhost:${handle.port}/`);
    expect(res.status).toBe(200);
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
