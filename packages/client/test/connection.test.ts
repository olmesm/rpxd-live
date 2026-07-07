import type { Envelope, RpcBatch } from "@rpxd/core";
import { describe, expect, it } from "vitest";
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
