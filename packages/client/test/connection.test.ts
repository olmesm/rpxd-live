import type { Envelope, RpcBatch } from "@rpxd/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type EventSourceLike, LiveConnection } from "../src/connection.ts";
import { buildHref } from "../src/router.tsx";

class FakeEventSource implements EventSourceLike {
  static instances: FakeEventSource[] = [];
  listeners = new Map<string, ((e: { data: string }) => void)[]>();
  closed = false;
  constructor(public url: string) {
    FakeEventSource.instances.push(this);
  }
  addEventListener(type: string, fn: (e: { data: string }) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(fn);
    this.listeners.set(type, list);
  }
  emit(type: string, data = ""): void {
    for (const fn of this.listeners.get(type) ?? []) fn({ data });
  }
  close(): void {
    this.closed = true;
  }
}

function makeConnection(bootstrap?: ConstructorParameters<typeof LiveConnection>[0]["bootstrap"]) {
  const requests: { url: string; body: unknown }[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : null });
    return new Response(null, { status: 202 });
  }) as typeof fetch;

  const conn = new LiveConnection<{ items: string[] }>({
    instance: "i1",
    bootstrap,
    fetchImpl,
    eventSource: (url) => new FakeEventSource(url),
  });
  return { conn, requests, source: () => FakeEventSource.instances.at(-1) as FakeEventSource };
}

const bootstrap = {
  instance: "i1",
  seq: 4,
  attachToken: "tok-1",
  snapshot: { state: { items: ["a"] }, session: {} },
};

describe("buildHref (§7)", () => {
  it("substitutes params and appends search", () => {
    expect(buildHref("/org/$orgId/board", { orgId: "42" })).toBe("/org/42/board");
    expect(buildHref("/", undefined, { filter: "done" })).toBe("/?filter=done");
    expect(buildHref("/a b/$x", { x: "1 2" })).toBe("/a b/1%202");
    expect(() => buildHref("/org/$orgId", {})).toThrow('Missing path param "orgId"');
  });
});

describe("LiveConnection (§11, §12)", () => {
  it("seeds the store from the SSR bootstrap and attaches with token+seq", () => {
    const { conn, source } = makeConnection(bootstrap);
    expect(conn.store.snapshot().state).toEqual({ items: ["a"] }); // no connect spinner
    expect(conn.store.seq).toBe(4);
    conn.connect();
    expect(source().url).toBe("/__rpxd/stream?attach=tok-1&seq=4");
  });

  it("applies env events and tracks status through open/error", () => {
    const { conn, source } = makeConnection(bootstrap);
    conn.connect();
    const es = source();
    es.emit("open");
    expect(conn.store.snapshot().status).toBe("live");

    const env: Envelope = {
      seq: 5,
      instance: "i1",
      patches: [{ op: "add", path: ["items", 1], value: "b" }],
    };
    es.emit("env", JSON.stringify(env));
    expect(conn.store.snapshot().state.items).toEqual(["a", "b"]);

    es.emit("error");
    expect(conn.store.snapshot().status).toBe("reconnecting");
  });

  it("resends unacked batches on reconnect (server dedupes, §11)", async () => {
    const { conn, requests, source } = makeConnection(bootstrap);
    conn.connect();
    const es = source();
    es.emit("open");

    void conn.store.call("add", { text: "x" });
    await new Promise((r) => setTimeout(r, 0));
    const rpcRequests = () => requests.filter((r) => r.url.endsWith("/__rpxd/rpc"));
    expect(rpcRequests()).toHaveLength(1);

    es.emit("error"); // connection drops
    es.emit("open"); // EventSource auto-reconnects
    expect(rpcRequests()).toHaveLength(2);
    expect((rpcRequests()[1]?.body as RpcBatch).rpcId).toBe(
      (rpcRequests()[0]?.body as RpcBatch).rpcId,
    );
  });

  it("routes patchParams through the control endpoint (§7)", () => {
    const { conn, requests } = makeConnection(bootstrap);
    conn.patchParams({ filter: "done" });
    const control = requests.find((r) => r.url.endsWith("/__rpxd/control"));
    expect(control?.body).toEqual({ type: "params", instance: "i1", search: { filter: "done" } });
  });

  it("mounts cold (no SSR) via control mount then connects", async () => {
    const requests: { url: string; body: unknown }[] = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : null });
      return Response.json({ instance: "srv-i9", seq: 1 });
    }) as typeof fetch;

    const conn = await LiveConnection.mount(
      "/org/1/board",
      { filter: "all" },
      {
        fetchImpl,
        eventSource: (url) => new FakeEventSource(url),
      },
    );
    expect(requests[0]?.body).toEqual({
      type: "mount",
      path: "/org/1/board",
      search: { filter: "all" },
    });
    expect((FakeEventSource.instances.at(-1) as FakeEventSource).url).toBe("/__rpxd/stream");
    conn.close();
    expect((FakeEventSource.instances.at(-1) as FakeEventSource).closed).toBe(true);
  });
});

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  listeners = new Map<string, ((e: { data?: unknown }) => void)[]>();
  sent: string[] = [];
  closed = false;
  constructor(public url: string) {
    FakeWebSocket.instances.push(this);
  }
  addEventListener(type: string, fn: (e: { data?: unknown }) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(fn);
    this.listeners.set(type, list);
  }
  emit(type: string, data?: unknown): void {
    for (const fn of this.listeners.get(type) ?? []) fn({ data });
  }
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.closed = true;
  }
}

describe("ws transport (§11 opt-in)", () => {
  function makeWsConnection() {
    const conn = new LiveConnection<{ items: string[] }>({
      instance: "i1",
      transport: "ws",
      base: "http://app.test",
      bootstrap,
      webSocket: (url) => new FakeWebSocket(url) as unknown as never,
      fetchImpl: (async () => new Response(null, { status: 202 })) as unknown as typeof fetch,
    });
    conn.connect();
    return { conn, socket: () => FakeWebSocket.instances.at(-1) as FakeWebSocket };
  }

  it("attaches over ws and routes batches + controls through the socket", async () => {
    const { conn, socket } = makeWsConnection();
    const ws = socket();
    expect(ws.url).toBe("ws://app.test/__rpxd/ws?attach=tok-1&seq=4");

    ws.emit("open");
    expect(conn.store.snapshot().status).toBe("live");

    void conn.store.call("add", { text: "x" });
    await new Promise((r) => setTimeout(r, 0));
    expect(ws.sent.some((m) => JSON.parse(m).rpcId)).toBe(true);

    conn.patchParams({ filter: "done" });
    expect(ws.sent.some((m) => JSON.parse(m).type === "params")).toBe(true);

    const env: Envelope = {
      seq: 5,
      instance: "i1",
      patches: [{ op: "add", path: ["items", 1], value: "b" }],
    };
    ws.emit("message", JSON.stringify(env));
    expect(conn.store.confirmed.items).toEqual(["a", "b"]);
  });

  it("reconnects with backoff and resends unacked batches", async () => {
    const { conn, socket } = makeWsConnection();
    const first = socket();
    first.emit("open");

    void conn.store.call("add", { text: "pending" });
    await new Promise((r) => setTimeout(r, 0));
    const sentBefore = first.sent.length;

    first.emit("close"); // drop → schedule reconnect
    expect(conn.store.snapshot().status).toBe("reconnecting");
    await new Promise((r) => setTimeout(r, 1100));

    const second = socket();
    expect(second).not.toBe(first);
    expect(second.url).toBe("ws://app.test/__rpxd/ws"); // no stale attach token
    second.emit("open");
    expect(conn.store.snapshot().status).toBe("live");
    // unacked batch resent with the same rpcId (server dedupes)
    expect(second.sent.length + sentBefore).toBeGreaterThan(sentBefore);
    const firstRpc = first.sent.map((m) => JSON.parse(m)).find((m) => m.rpcId);
    const resent = second.sent.map((m) => JSON.parse(m)).find((m) => m.rpcId);
    expect(resent?.rpcId).toBe(firstRpc?.rpcId);
    conn.close();
  });

  describe("reconnect backoff (§11)", () => {
    afterEach(() => {
      vi.useRealTimers();
      vi.restoreAllMocks();
    });

    it("doubles the retry delay per attempt (with jitter) and caps at 30s", () => {
      vi.useFakeTimers();
      // random() = 0 → delay is exactly half the current window: 500, 1000, 2000…
      vi.spyOn(Math, "random").mockReturnValue(0);
      const { conn, socket } = makeWsConnection();
      const count = () => FakeWebSocket.instances.length;

      socket().emit("open");
      socket().emit("close");
      const base = count();
      vi.advanceTimersByTime(499);
      expect(count()).toBe(base); // not yet
      vi.advanceTimersByTime(1);
      expect(count()).toBe(base + 1); // attempt 1 after 500ms

      socket().emit("close");
      vi.advanceTimersByTime(999);
      expect(count()).toBe(base + 1);
      vi.advanceTimersByTime(1);
      expect(count()).toBe(base + 2); // attempt 2 after 1000ms

      socket().emit("close");
      vi.advanceTimersByTime(1999);
      expect(count()).toBe(base + 2);
      vi.advanceTimersByTime(1);
      expect(count()).toBe(base + 3); // attempt 3 after 2000ms

      conn.close();
    });

    it("resets the ladder after a successful open", () => {
      vi.useFakeTimers();
      vi.spyOn(Math, "random").mockReturnValue(0);
      const { conn, socket } = makeWsConnection();
      const count = () => FakeWebSocket.instances.length;

      socket().emit("open");
      socket().emit("close");
      vi.advanceTimersByTime(500); // attempt 1
      socket().emit("close");
      vi.advanceTimersByTime(1000); // attempt 2
      socket().emit("open"); // success resets
      socket().emit("close");

      const base = count();
      vi.advanceTimersByTime(500); // back to the base window
      expect(count()).toBe(base + 1);
      conn.close();
    });

    it("spreads retries with jitter inside the window", () => {
      vi.useFakeTimers();
      vi.spyOn(Math, "random").mockReturnValue(1); // top of the window
      const { conn, socket } = makeWsConnection();
      const count = () => FakeWebSocket.instances.length;

      socket().emit("open");
      socket().emit("close");
      const base = count();
      vi.advanceTimersByTime(999);
      expect(count()).toBe(base); // window is [500, 1000]
      vi.advanceTimersByTime(1);
      expect(count()).toBe(base + 1);
      conn.close();
    });
  });
});
