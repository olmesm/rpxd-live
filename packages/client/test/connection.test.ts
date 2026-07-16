import type { Envelope, RpcBatch } from "@rpxd/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type EventSourceLike, LiveConnection } from "../src/connection.ts";
import { buildHref } from "../src/router.tsx";

class FakeEventSource implements EventSourceLike {
  static instances: FakeEventSource[] = [];
  listeners = new Map<string, ((e: { data: string }) => void)[]>();
  closed = false;
  /** 0 CONNECTING, 1 OPEN, 2 CLOSED — mirrors the real EventSource. */
  readyState = 0;
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
    // Carries the attach token+seq and this connection's stream id (§7).
    expect(source().url).toMatch(/^\/__rpxd\/stream\?attach=tok-1&seq=4&stream=.+/);
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

  it("a refused SSE stream (CLOSED before any open) goes terminal error, no retry (W7)", () => {
    const { conn, source } = makeConnection(bootstrap);
    conn.connect();
    const es = source();
    const before = FakeEventSource.instances.length;
    // A 403 refusal closes the EventSource permanently: readyState CLOSED,
    // no prior `open` event.
    es.readyState = 2;
    es.emit("error");
    expect(conn.store.snapshot().status).toBe("error");
    expect(es.closed).toBe(true); // closed so it can't native-reconnect into a loop
    expect(FakeEventSource.instances.length).toBe(before); // nothing re-created
  });

  it("a drop AFTER a successful open goes reconnecting and keeps the source (regression)", () => {
    const { conn, source } = makeConnection(bootstrap);
    conn.connect();
    const es = source();
    es.emit("open"); // opened successfully first
    es.readyState = 0; // EventSource is auto-reconnecting (CONNECTING)
    es.emit("error");
    expect(conn.store.snapshot().status).toBe("reconnecting");
    expect(es.closed).toBe(false); // left open for native auto-reconnect
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

  it("routes patchProps (tier 1) through the control endpoint as a url change (§7)", () => {
    const { conn, requests } = makeConnection(bootstrap);
    conn.patchProps({ filter: "done" });
    const control = requests.find((r) => r.url.endsWith("/__rpxd/control"));
    expect(control?.body).toEqual({ type: "url", instance: "i1", props: { filter: "done" } });
  });

  it("a guard deny during patchProps routes { redirect } to onRedirect (§10)", async () => {
    const redirects: string[] = [];
    const fetchImpl = (async () =>
      Response.json({ redirect: "/login" })) as unknown as typeof fetch;
    const conn = new LiveConnection<{ items: string[] }>({
      instance: "i1",
      bootstrap,
      fetchImpl,
      onRedirect: (loc) => redirects.push(loc),
      eventSource: (url) => new FakeEventSource(url),
    });
    conn.patchProps({ admin: "1" });
    await new Promise((r) => setTimeout(r, 0));
    expect(redirects).toEqual(["/login"]);
  });

  it("refuses an unsafe (cross-origin / javascript:) redirect target (§10)", async () => {
    const redirects: string[] = [];
    const fetchImpl = (async () =>
      Response.json({ redirect: "javascript:alert(document.cookie)" })) as unknown as typeof fetch;
    const conn = new LiveConnection<{ items: string[] }>({
      instance: "i1",
      bootstrap,
      fetchImpl,
      onRedirect: (loc) => redirects.push(loc),
      eventSource: (url) => new FakeEventSource(url),
    });
    conn.patchProps({ admin: "1" });
    await new Promise((r) => setTimeout(r, 0));
    // A server-supplied redirect that isn't a same-origin path must be dropped,
    // not handed to the router / window.location.
    expect(redirects).toEqual([]);
  });

  it("tier-2 remount swaps the store, resyncs the new instance, releases the old (§7)", async () => {
    const requests: { url: string; body: unknown }[] = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      requests.push({ url: String(url), body });
      if (body?.type === "mount") return Response.json({ instance: "srv-i2", seq: 1 });
      return new Response(null, { status: 204 });
    }) as typeof fetch;
    const conn = new LiveConnection<{ items: string[] }>({
      instance: "srv-i1",
      fetchImpl,
      eventSource: (url) => new FakeEventSource(url),
    });
    conn.connect();
    const before = conn.store;

    await conn.remount("/t/2", { q: "x" });
    expect(conn.store).not.toBe(before); // rebound to a fresh store

    const control = requests.filter((r) => r.url.endsWith("/__rpxd/control")).map((r) => r.body);
    // mount names this stream, resync targets the new instance, release drops the old.
    const mount = control.find((b) => (b as { type: string }).type === "mount") as {
      path: string;
      stream: string;
    };
    expect(mount.path).toBe("/t/2");
    expect(typeof mount.stream).toBe("string");
    expect(control).toContainEqual({ type: "resync", instance: "srv-i2" });
    expect(control).toContainEqual({ type: "release", instance: "srv-i1", stream: mount.stream });

    // The new store applies the new instance's snapshot off the shared stream.
    const es = FakeEventSource.instances.at(-1) as FakeEventSource;
    es.emit(
      "env",
      JSON.stringify({
        seq: 1,
        instance: "srv-i2",
        full: { state: { items: ["z"] }, session: {} },
      }),
    );
    expect(conn.store.snapshot().state).toEqual({ items: ["z"] });
  });

  it("latest-wins: a superseded remount (resolving late) does not rebind the store (§7)", async () => {
    const control: { body: Record<string, unknown> | null }[] = [];
    let resolveOld: (r: Response) => void = () => {};
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      control.push({ body });
      // Older remount (→/t/2) resolves LATE; newer (→/t/3) resolves immediately.
      if (body?.type === "mount" && body.path === "/t/2") {
        return new Promise<Response>((res) => {
          resolveOld = res;
        });
      }
      if (body?.type === "mount") return Response.json({ instance: "i3", seq: 1 });
      return new Response(null, { status: 204 });
    }) as typeof fetch;
    const conn = new LiveConnection<{ items: string[] }>({
      instance: "i1",
      fetchImpl,
      eventSource: (url) => new FakeEventSource(url),
    });
    conn.connect();

    const older = conn.remount("/t/2", {}); // runId 1 — mount pending
    const newer = conn.remount("/t/3", {}); // runId 2 — wins
    await newer;
    resolveOld(Response.json({ instance: "i2", seq: 1 })); // older resolves out of order
    await older;

    const bodies = control.map((c) => c.body);
    // The winner (i3) rebound + resynced; the superseded run never resyncs i2.
    expect(bodies).toContainEqual({ type: "resync", instance: "i3" });
    expect(bodies).not.toContainEqual({ type: "resync", instance: "i2" });
    // The superseded run releases the instance it mounted so it doesn't leak.
    expect(bodies).toContainEqual(expect.objectContaining({ type: "release", instance: "i2" }));

    // The store is bound to i3: an i2 snapshot is ignored, an i3 one applies.
    const es = FakeEventSource.instances.at(-1) as FakeEventSource;
    es.emit(
      "env",
      JSON.stringify({ seq: 1, instance: "i2", full: { state: { items: ["old"] }, session: {} } }),
    );
    es.emit(
      "env",
      JSON.stringify({ seq: 1, instance: "i3", full: { state: { items: ["new"] }, session: {} } }),
    );
    expect(conn.store.snapshot().state).toEqual({ items: ["new"] });
  });

  it("remount rethrows a setup/guard redirect for the router to soft-nav (§10)", async () => {
    const fetchImpl = (async () =>
      Response.json({ redirect: "/login" })) as unknown as typeof fetch;
    const conn = new LiveConnection<{ items: string[] }>({
      instance: "srv-i1",
      fetchImpl,
      eventSource: (url) => new FakeEventSource(url),
    });
    conn.connect();
    await expect(conn.remount("/t/2", {})).rejects.toMatchObject({ location: "/login" });
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
      props: { filter: "all" },
    });
    expect((FakeEventSource.instances.at(-1) as FakeEventSource).url).toMatch(
      /^\/__rpxd\/stream\?stream=.+/,
    );
    conn.close();
    expect((FakeEventSource.instances.at(-1) as FakeEventSource).closed).toBe(true);
  });
});

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  listeners = new Map<string, ((e: { data?: unknown; code?: number }) => void)[]>();
  sent: string[] = [];
  closed = false;
  constructor(public url: string) {
    FakeWebSocket.instances.push(this);
  }
  addEventListener(type: string, fn: (e: { data?: unknown; code?: number }) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(fn);
    this.listeners.set(type, list);
  }
  emit(type: string, data?: unknown, code?: number): void {
    for (const fn of this.listeners.get(type) ?? []) fn({ data, code });
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
    const redirects: string[] = [];
    const conn = new LiveConnection<{ items: string[] }>({
      instance: "i1",
      transport: "ws",
      base: "http://app.test",
      bootstrap,
      onRedirect: (loc) => redirects.push(loc),
      webSocket: (url) => new FakeWebSocket(url) as unknown as never,
      fetchImpl: (async () => new Response(null, { status: 202 })) as unknown as typeof fetch,
    });
    conn.connect();
    return { conn, redirects, socket: () => FakeWebSocket.instances.at(-1) as FakeWebSocket };
  }

  it("attaches over ws and routes batches + controls through the socket", async () => {
    const { conn, redirects, socket } = makeWsConnection();
    const ws = socket();
    expect(ws.url).toBe("ws://app.test/__rpxd/ws?attach=tok-1&seq=4");

    ws.emit("open");
    expect(conn.store.snapshot().status).toBe("live");

    void conn.store.call("add", { text: "x" });
    await new Promise((r) => setTimeout(r, 0));
    expect(ws.sent.some((m) => JSON.parse(m).rpcId)).toBe(true);

    conn.patchProps({ filter: "done" });
    expect(ws.sent.some((m) => JSON.parse(m).type === "url")).toBe(true);

    const env: Envelope = {
      seq: 5,
      instance: "i1",
      patches: [{ op: "add", path: ["items", 1], value: "b" }],
    };
    ws.emit("message", JSON.stringify(env));
    expect(conn.store.confirmed.items).toEqual(["a", "b"]);

    // A WS runtime deny arrives as a redirect envelope → onRedirect (§10).
    ws.emit("message", JSON.stringify({ seq: 6, instance: "i1", redirect: "/403" }));
    expect(redirects).toEqual(["/403"]);
  });

  it("correlates an unbound mount-deny redirect by mountId (#65)", async () => {
    // A socket mount that denies with no warm instance answers with
    // `instance: ""` — the bound-instance filter can never match it, so the
    // client correlates via the mountId it sent on the mount frame.
    const redirects: string[] = [];
    const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      if (body?.type === "mount") return Response.json({ instance: "srv-i2", seq: 1 });
      return new Response(null, { status: 202 });
    }) as unknown as typeof fetch;
    const conn = new LiveConnection<{ items: string[] }>({
      instance: "i1",
      transport: "ws",
      base: "http://app.test",
      bootstrap,
      onRedirect: (loc) => redirects.push(loc),
      webSocket: (url) => new FakeWebSocket(url) as unknown as never,
      fetchImpl,
    });
    conn.connect();
    const ws = FakeWebSocket.instances.at(-1) as FakeWebSocket;
    ws.emit("open");

    await conn.remount("/t/2", {});
    const frame = ws.sent.map((m) => JSON.parse(m)).find((m) => m.type === "mount") as {
      mountId?: string;
    };
    expect(typeof frame.mountId).toBe("string");

    // A stale/foreign mountId on an unbound redirect must NOT navigate…
    ws.emit(
      "message",
      JSON.stringify({ seq: 0, instance: "", redirect: "/elsewhere", mountId: "other" }),
    );
    expect(redirects).toEqual([]);
    // …the in-flight mount's own id must.
    ws.emit(
      "message",
      JSON.stringify({ seq: 0, instance: "", redirect: "/login", mountId: frame.mountId }),
    );
    expect(redirects).toEqual(["/login"]);
    conn.close();
  });

  it("a 4403 policy close goes terminal error, no retry (W7)", () => {
    vi.useFakeTimers();
    const { conn, socket } = makeWsConnection();
    const ws = socket();
    const before = FakeWebSocket.instances.length;
    // The server closed with the explicit policy code — the one "don't come
    // back" signal a WS client can actually observe.
    ws.emit("close", undefined, 4403);
    expect(conn.store.snapshot().status).toBe("error");
    vi.advanceTimersByTime(60_000);
    expect(FakeWebSocket.instances.length).toBe(before); // no reconnect scheduled
    conn.close();
    vi.useRealTimers();
  });

  it("a pre-open close without a policy code backoff-retries — a server bounce on first load must not strand the page", () => {
    vi.useFakeTimers();
    const { conn, socket } = makeWsConnection();
    const ws = socket();
    const before = FakeWebSocket.instances.length;
    // Transient failure on the very first connect (e.g. server mid-restart):
    // the socket closes before `open` with a generic code. A browser client
    // can't distinguish this from a refused upgrade, so it must keep trying.
    ws.emit("close", undefined, 1006);
    expect(conn.store.snapshot().status).toBe("reconnecting");
    vi.advanceTimersByTime(60_000);
    expect(FakeWebSocket.instances.length).toBeGreaterThan(before); // reconnect scheduled
    conn.close();
    vi.useRealTimers();
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
