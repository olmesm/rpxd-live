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
import { nodeAdapter, writeChunk, writeWebResponse } from "../src/index.ts";

/** A live (not-yet-departed) node response double with the flags `writeChunk` consults. */
function fakeRes(overrides: Record<string, unknown>): ServerResponse {
  return Object.assign(new EventEmitter(), {
    destroyed: false,
    writableEnded: false,
    writable: true,
    ...overrides,
  }) as unknown as ServerResponse;
}

describe("writeWebResponse — body-error reap", () => {
  it("destroys the response when the body stream errors while parked on backpressure", async () => {
    // The egress-budget kill (server-bun) errors the body stream of a stalled
    // client. That client never fires 'drain', so the parked writeChunk can't
    // observe the rejection — the adapter must destroy the response to unstick
    // the loop and reap the socket, or every killed laggard leaks a connection.
    let destroyed = false;
    const res = fakeRes({
      write: () => false, // every write parks — a fully stalled socket
      setHeader: () => {},
      end: () => {},
      destroy(this: ServerResponse) {
        destroyed = true;
        (this as unknown as { destroyed: boolean }).destroyed = true;
        this.emit("close");
      },
    });
    let ctrl!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        ctrl = c;
      },
    });
    ctrl.enqueue(new Uint8Array([1])); // first chunk parks the write loop
    const done = writeWebResponse(res, new Response(body));
    await new Promise((r) => setTimeout(r, 20)); // loop is parked on 'drain'
    ctrl.error(new Error("egress buffer exceeded maxBufferedBytes"));
    const settled = await Promise.race([
      done.then(() => true),
      new Promise<boolean>((r) => setTimeout(() => r(false), 500)),
    ]);
    expect(destroyed).toBe(true); // socket reaped, not left half-open
    expect(settled).toBe(true); // and the write loop actually exited
  });

  it("does not destroy on a normally completed body", async () => {
    let destroyed = false;
    const res = fakeRes({
      write: () => true,
      setHeader: () => {},
      end: () => {},
      destroy() {
        destroyed = true;
      },
    });
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new Uint8Array([1]));
        c.close();
      },
    });
    await writeWebResponse(res, new Response(body));
    await new Promise((r) => setTimeout(r, 10));
    expect(destroyed).toBe(false); // clean end stays a clean end
  });
});

describe("writeChunk backpressure", () => {
  it("resolves immediately when the socket accepts the write", async () => {
    const res = fakeRes({ write: () => true });
    await writeChunk(res, new Uint8Array([1])); // must not hang
  });

  it("waits for 'drain' when the socket signals backpressure", async () => {
    const res = fakeRes({ write: () => false });
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
    const res = fakeRes({ write: () => false });
    const p = writeChunk(res, new Uint8Array([1]));
    res.emit("close");
    await p; // resolves instead of leaking forever
  });

  it("resolves instead of parking when the response is already gone", async () => {
    // The race: the client disconnected ('close' already fired) before this
    // write, so waiting for 'drain'/'close' would wait forever.
    const res = fakeRes({ write: () => false, destroyed: true, writable: false });
    const settled = await Promise.race([
      writeChunk(res, new Uint8Array([1])).then(() => true),
      new Promise<boolean>((r) => setTimeout(() => r(false), 200)),
    ]);
    expect(settled).toBe(true);
  });

  it("settles on 'error' while parked", async () => {
    const res = fakeRes({ write: () => false });
    const p = writeChunk(res, new Uint8Array([1]));
    res.emit("error", new Error("boom"));
    await p; // resolves instead of leaking (or crashing on an unhandled 'error')
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

  it("survives a client reset during the ws upgrade handshake gap", async () => {
    const handler = createRpxdHandler({ routes: [{ path: "/", def }], warmTtlMs: 10 });
    const ws = wsTransport(handler);
    let arrived!: () => void;
    const upgradeArrived = new Promise<void>((r) => {
      arrived = r;
    });
    let release!: () => void;
    const authGate = new Promise<void>((r) => {
      release = r;
    });
    const uncaught: unknown[] = [];
    const onUncaught = (e: unknown) => {
      uncaught.push(e);
    };
    process.on("uncaughtException", onUncaught);
    cleanups.push(() => {
      process.off("uncaughtException", onUncaught);
    });

    const handle = nodeAdapter().serve({
      port: 0,
      websocket: ws.websocket,
      fetch: async (req, upgrade) => {
        if (new URL(req.url).pathname === "/__rpxd/ws") {
          arrived();
          await authGate; // slow authenticate — the client resets inside this gap
        }
        return (await ws.handleUpgrade(req, upgrade)) ?? handler.fetch(req);
      },
    });
    cleanups.push(
      () => handler.dispose(),
      () => handle.stop(),
    );
    await handle.ready;

    const client = net.connect(handle.port, "localhost", () => {
      client.write(
        `${[
          "GET /__rpxd/ws HTTP/1.1",
          "Host: localhost",
          "Upgrade: websocket",
          "Connection: Upgrade",
          "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
          "Sec-WebSocket-Version: 13",
        ].join("\r\n")}\r\n\r\n`,
      );
    });
    client.on("error", () => {}); // the reset below is deliberate
    await upgradeArrived;
    client.resetAndDestroy(); // RST mid-gap, before fetch has decided
    await new Promise((r) => setTimeout(r, 100)); // let the RST reach the server socket
    release();
    await new Promise((r) => setTimeout(r, 100)); // let the post-gap upgrade/decline hit the dead socket

    expect(uncaught).toEqual([]); // a client reset must never be an uncaughtException
    const res = await fetch(`http://localhost:${handle.port}/`);
    expect(res.status).toBe(200); // and the server is still alive
  });

  it("releases the response stream when the client disconnects mid-stream", async () => {
    let cancelled!: () => void;
    const streamReleased = new Promise<void>((r) => {
      cancelled = r;
    });
    const chunk = new TextEncoder().encode("x".repeat(64 * 1024));
    const handle = nodeAdapter().serve({
      port: 0,
      // SSE-shaped: an endless body that only stops when the consumer cancels.
      fetch: () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              controller.enqueue(chunk);
            },
            cancel() {
              cancelled();
            },
          }),
          { headers: { "content-type": "application/octet-stream" } },
        ),
    });
    cleanups.push(() => handle.stop());
    await handle.ready;

    const client = net.connect(handle.port, "localhost", () => {
      client.write("GET / HTTP/1.1\r\nHost: localhost\r\n\r\n");
    });
    client.on("error", () => {});
    await new Promise<void>((r) => client.once("data", () => r()));
    client.destroy(); // vanish while chunks are in flight

    // Without the disconnect check the write loop parks forever on a 'close'
    // that already fired, and the body stream is never cancelled.
    const released = await Promise.race([
      streamReleased.then(() => true),
      new Promise<boolean>((r) => setTimeout(() => r(false), 3000)),
    ]);
    expect(released).toBe(true);
  });

  it("enforces the body cap on the node stream path (413)", async () => {
    // The node adapter converts the raw request stream straight to a web
    // Request, so without the handler-level cap this path was fully unbounded
    // (issue #51). The cap lives in the shared handler, so Bun and Node behave
    // identically.
    const handler = createRpxdHandler({
      routes: [{ path: "/", def }],
      warmTtlMs: 10,
      maxBodyBytes: 512,
    });
    const handle = nodeAdapter().serve({ port: 0, fetch: handler.fetch });
    cleanups.push(
      () => handler.dispose(),
      () => handle.stop(),
    );
    await handle.ready;

    const oversized = await fetch(`http://localhost:${handle.port}/__rpxd/control`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "mount", path: `/${"x".repeat(2000)}` }),
    });
    expect(oversized.status).toBe(413);

    // A request within the limit still works.
    const ok = await fetch(`http://localhost:${handle.port}/__rpxd/control`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "mount", path: "/" }),
    });
    expect(ok.status).toBe(200);
  });

  it("reads env through the seam", () => {
    process.env.RPXD_NODE_TEST_ENV = "yes";
    expect(nodeAdapter().env("RPXD_NODE_TEST_ENV")).toBe("yes");
  });

  it("upgrades a websocket and delivers the initial envelope", async () => {
    // fixed literal cookie below (shared between the mount fetch and the WS
    // upgrade) needs a stable, unsigned sid — see S1 (session-cookie signing
    // now on by default under dev's ephemeral secret).
    const handler = createRpxdHandler({
      routes: [{ path: "/", def }],
      warmTtlMs: 10,
      cookie: { sign: false },
    });
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
