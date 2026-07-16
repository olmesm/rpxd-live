import { type Envelope, isRedirect, type MountBatchResult, type RpcBatch } from "@rpxd/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type EventSourceLike, LiveConnection } from "../src/connection.ts";
import { buildHref } from "../src/router.tsx";
import type { RpcMeta } from "../src/store.ts";

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

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

describe("store multiplexing (ADR 0002 item 9)", () => {
  /** A connection whose control mounts answer with a per-path instance id. */
  function makeMux(opts: { urlRedirect?: string } = {}) {
    const requests: { url: string; body: Record<string, unknown> | null }[] = [];
    const redirects: string[] = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      requests.push({ url: String(url), body });
      if (body?.type === "mount") {
        const inst = body.path === "/chat/main" ? "slot-i" : "srv-i2";
        return Response.json({ instance: inst, seq: 1 });
      }
      if (body?.type === "url" && opts.urlRedirect) {
        return Response.json({ redirect: opts.urlRedirect });
      }
      return new Response(null, { status: 204 });
    }) as typeof fetch;
    const conn = new LiveConnection<{ items: string[] }>({
      instance: "i1",
      bootstrap,
      fetchImpl,
      onRedirect: (loc) => redirects.push(loc),
      eventSource: (url) => new FakeEventSource(url),
    });
    conn.connect();
    const source = () => FakeEventSource.instances.at(-1) as FakeEventSource;
    source().emit("open");
    const controls = () =>
      requests.filter((r) => r.url.endsWith("/__rpxd/control")).map((r) => r.body);
    const rpcs = () => requests.filter((r) => r.url.endsWith("/__rpxd/rpc"));
    return { conn, requests, redirects, source, controls, rpcs };
  }

  it("mountSlot sends a control mount naming the stream and returns a bound handle", async () => {
    const { conn, controls } = makeMux();
    const slot = await conn.mountSlot<{ items: string[] }>("/chat/main", { topic: "x" });
    const mount = controls().find((b) => b?.type === "mount") as {
      path: string;
      props: unknown;
      stream: string;
    };
    expect(mount).toMatchObject({ type: "mount", path: "/chat/main", props: { topic: "x" } });
    expect(typeof mount.stream).toBe("string");
    expect(slot.instance).toBe("slot-i");
    // SSE: after the join at mount, resync targets the slot instance.
    expect(controls()).toContainEqual({ type: "resync", instance: "slot-i" });
  });

  it("routes envelopes to each instance's own store, never crossing", async () => {
    const { conn, source } = makeMux();
    const slot = await conn.mountSlot<{ items: string[] }>("/chat/main", {});
    source().emit(
      "env",
      JSON.stringify({
        seq: 5,
        instance: "i1",
        patches: [{ op: "add", path: ["items", 1], value: "b" }],
      }),
    );
    source().emit(
      "env",
      JSON.stringify({
        seq: 1,
        instance: "slot-i",
        full: { state: { items: ["z"] }, session: {} },
      }),
    );
    expect(conn.store.snapshot().state.items).toEqual(["a", "b"]);
    expect(slot.store.snapshot().state).toEqual({ items: ["z"] });

    // A slot-targeted patch must not touch the page store, and vice versa.
    source().emit(
      "env",
      JSON.stringify({
        seq: 2,
        instance: "slot-i",
        patches: [{ op: "add", path: ["items", 1], value: "y" }],
      }),
    );
    expect(conn.store.snapshot().state.items).toEqual(["a", "b"]); // page untouched
    expect(slot.store.snapshot().state.items).toEqual(["z", "y"]);
  });

  it("handle.patchProps sends a url message for the slot instance", async () => {
    const { conn, controls } = makeMux();
    const slot = await conn.mountSlot("/chat/main", {});
    slot.patchProps({ topic: "y" });
    await tick();
    expect(controls()).toContainEqual({ type: "url", instance: "slot-i", props: { topic: "y" } });
  });

  it("handle.release releases the instance and deregisters its store", async () => {
    const { conn, source, controls } = makeMux();
    const slot = await conn.mountSlot<{ items: string[] }>("/chat/main", {});
    source().emit(
      "env",
      JSON.stringify({
        seq: 1,
        instance: "slot-i",
        full: { state: { items: ["s"] }, session: {} },
      }),
    );
    expect(slot.store.snapshot().state.items).toEqual(["s"]);

    // Release is deferred to the next microtask flush (ADR 0002 item 12) so a
    // same-tick remount could cancel it — an unpaired release still goes out.
    slot.release();
    await tick();
    expect(controls()).toContainEqual(
      expect.objectContaining({ type: "release", instance: "slot-i" }),
    );
    // After release, envelopes for that instance no longer dispatch.
    source().emit(
      "env",
      JSON.stringify({
        seq: 2,
        instance: "slot-i",
        full: { state: { items: ["gone"] }, session: {} },
      }),
    );
    expect(slot.store.snapshot().state.items).toEqual(["s"]); // unchanged
  });

  it("a slot runtime deny (url redirect) fires its onDeny sink, not the app redirect (§10)", async () => {
    const { conn, redirects } = makeMux({ urlRedirect: "/login" });
    const slot = await conn.mountSlot("/chat/main", {});
    const denies: string[] = [];
    slot.onDeny((loc) => denies.push(loc));
    slot.patchProps({ admin: "1" });
    await tick();
    expect(denies).toEqual(["/login"]);
    expect(redirects).toEqual([]); // the app-level onRedirect is never called
  });

  it("a slot deny envelope on the stream fires its sink; the primary redirect still works", async () => {
    const { conn, source, redirects } = makeMux();
    const slot = await conn.mountSlot("/chat/main", {});
    const denies: string[] = [];
    slot.onDeny((loc) => denies.push(loc));

    // A redirect envelope tagged with the slot instance → the slot's sink.
    source().emit("env", JSON.stringify({ seq: 0, instance: "slot-i", redirect: "/slot-login" }));
    expect(denies).toEqual(["/slot-login"]);
    expect(redirects).toEqual([]);

    // A redirect envelope for the primary instance still soft-navs the app.
    source().emit("env", JSON.stringify({ seq: 0, instance: "i1", redirect: "/app-login" }));
    expect(redirects).toEqual(["/app-login"]);
    expect(denies).toEqual(["/slot-login"]); // slot sink not re-fired
  });

  it("reconnect resends unacked from page AND slot stores, and every store recovers (blast radius)", async () => {
    const { conn, source, rpcs } = makeMux();
    const es = source();
    const slot = await conn.mountSlot<{ items: string[] }>("/chat/main", {});
    es.emit(
      "env",
      JSON.stringify({
        seq: 1,
        instance: "slot-i",
        full: { state: { items: ["s"] }, session: {} },
      }),
    );

    void conn.store.call("add", { text: "p" });
    void slot.store.call("add", { text: "q" });
    await tick();
    expect(rpcs()).toHaveLength(2); // one pending batch per store

    // A slow-consumer kill: the SSE stream errors, then the EventSource
    // auto-reconnects (open again). The server resyncs every subscribed
    // instance on re-subscribe — modelled here by fresh fulls after open.
    es.emit("error");
    es.emit("open");
    expect(rpcs()).toHaveLength(4); // both unacked batches resent (server dedupes)

    es.emit(
      "env",
      JSON.stringify({
        seq: 10,
        instance: "i1",
        full: { state: { items: ["a", "recovered"] }, session: {} },
      }),
    );
    es.emit(
      "env",
      JSON.stringify({
        seq: 5,
        instance: "slot-i",
        full: { state: { items: ["s2"] }, session: {} },
      }),
    );
    expect(conn.store.snapshot().state.items).toEqual(["a", "recovered"]);
    expect(slot.store.snapshot().state.items).toEqual(["s2"]);
  });

  it("remount reuses the transport (no new EventSource) and leaves slot stores flowing", async () => {
    const { conn, source } = makeMux();
    const before = FakeEventSource.instances.length;
    const slot = await conn.mountSlot<{ items: string[] }>("/chat/main", {});
    source().emit(
      "env",
      JSON.stringify({
        seq: 1,
        instance: "slot-i",
        full: { state: { items: ["s"] }, session: {} },
      }),
    );

    // A tier-3 page swap: remount over the same stream with the new route meta.
    const meta: Record<string, RpcMeta> = {
      add: {
        optimistic: (s: { items: string[] }, { text }: { text: string }) => s.items.push(text),
      },
    };
    await conn.remount("/other", {}, meta);
    expect(FakeEventSource.instances.length).toBe(before); // NO new transport built

    // The swapped primary store optimistics with the NEW route meta.
    source().emit(
      "env",
      JSON.stringify({ seq: 1, instance: "srv-i2", full: { state: { items: [] }, session: {} } }),
    );
    void conn.store.call("add", { text: "opt" });
    await tick();
    expect(conn.store.snapshot().state.items).toEqual(["opt"]); // meta.optimistic ran

    // Envelopes keep flowing to the slot store across the page swap.
    source().emit(
      "env",
      JSON.stringify({
        seq: 2,
        instance: "slot-i",
        patches: [{ op: "add", path: ["items", 1], value: "mid" }],
      }),
    );
    expect(slot.store.snapshot().state.items).toEqual(["s", "mid"]);
  });
});

describe("batched slot mounts (ADR 0002 item 11)", () => {
  /**
   * A connection whose control POSTs are captured. A `mount-batch` answers
   * positionally (default: every entry → its own instance; override via
   * `batchResults` to inject a redirect/error); a lone `mount` answers as today.
   */
  function makeBatchConn(
    opts: { batchResults?: (mounts: { path: string }[]) => MountBatchResult[] } = {},
  ) {
    const controlBodies: Record<string, unknown>[] = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      if (String(url).endsWith("/__rpxd/control")) {
        if (body) controlBodies.push(body);
        if (body?.type === "mount-batch") {
          const mounts = body.mounts as { path: string }[];
          const results = opts.batchResults
            ? opts.batchResults(mounts)
            : mounts.map((m) => ({ instance: `inst${m.path}`, seq: 1 }));
          return Response.json({ results });
        }
        if (body?.type === "mount") {
          return Response.json({ instance: `inst${body.path}`, seq: 1 });
        }
        return new Response(null, { status: 204 });
      }
      return new Response(null, { status: 202 });
    }) as typeof fetch;
    const conn = new LiveConnection<{ items: string[] }>({
      instance: "i1",
      bootstrap,
      fetchImpl,
      eventSource: (url) => new FakeEventSource(url),
    });
    conn.connect();
    (FakeEventSource.instances.at(-1) as FakeEventSource).emit("open");
    const posts = () => controlBodies;
    const of = (type: string) => controlBodies.filter((b) => b?.type === type);
    return { conn, posts, of };
  }

  it("coalesces 5 same-tick mountSlot calls into ONE mount-batch POST", async () => {
    const { conn, of } = makeBatchConn();
    // Five mounts issued synchronously in one tick → one microtask flush.
    const handles = await Promise.all(
      [0, 1, 2, 3, 4].map((i) => conn.mountSlot<{ items: string[] }>(`/card/${i}`, {})),
    );
    const batches = of("mount-batch") as { mounts: { path: string }[] }[];
    expect(batches).toHaveLength(1);
    expect(of("mount")).toHaveLength(0); // never an unbatched single alongside
    expect(batches[0]?.mounts.map((m) => m.path)).toEqual([
      "/card/0",
      "/card/1",
      "/card/2",
      "/card/3",
      "/card/4",
    ]);
    // Each handle resolves with its OWN instance, positionally.
    expect(handles.map((h) => h.instance)).toEqual([
      "inst/card/0",
      "inst/card/1",
      "inst/card/2",
      "inst/card/3",
      "inst/card/4",
    ]);
  });

  it("settles each entry independently — a redirect among instances rejects only its caller", async () => {
    const { conn } = makeBatchConn({
      batchResults: (mounts) =>
        mounts.map((m, i) =>
          i === 2 ? { redirect: "/login" } : { instance: `inst${m.path}`, seq: 1 },
        ),
    });
    const settled = await Promise.allSettled(
      [0, 1, 2, 3, 4].map((i) => conn.mountSlot(`/card/${i}`, {})),
    );
    // Four resolve with their instance; the third rejects with a thrown redirect.
    expect(settled.map((s) => s.status)).toEqual([
      "fulfilled",
      "fulfilled",
      "rejected",
      "fulfilled",
      "fulfilled",
    ]);
    const denied = settled[2] as PromiseRejectedResult;
    expect(isRedirect(denied.reason)).toBe(true);
    expect(denied.reason.location).toBe("/login");
    // Siblings are unaffected — instances 0,1,3,4 all bound.
    const instances = settled
      .map((s) => (s.status === "fulfilled" ? s.value.instance : null))
      .filter((x) => x !== null);
    expect(instances).toEqual(["inst/card/0", "inst/card/1", "inst/card/3", "inst/card/4"]);
  });

  it("an `{ error }` entry rejects only its caller (siblings unaffected)", async () => {
    const { conn } = makeBatchConn({
      batchResults: (mounts) =>
        mounts.map((m, i) =>
          i === 1
            ? { error: { name: "ValidationError", message: "invalid props" } }
            : { instance: `inst${m.path}`, seq: 1 },
        ),
    });
    const settled = await Promise.allSettled(
      [0, 1, 2].map((i) => conn.mountSlot(`/card/${i}`, {})),
    );
    expect(settled[0]?.status).toBe("fulfilled");
    expect(settled[1]?.status).toBe("rejected");
    expect((settled[1] as PromiseRejectedResult).reason).toBeInstanceOf(Error);
    expect((settled[1] as PromiseRejectedResult).reason.message).toBe("invalid props");
    expect(settled[2]?.status).toBe("fulfilled");
  });

  it("a lone same-tick mountSlot stays the unbatched `mount` shape (regression)", async () => {
    const { conn, of } = makeBatchConn();
    const handle = await conn.mountSlot("/chat/main", { topic: "x" });
    expect(of("mount-batch")).toHaveLength(0);
    const mounts = of("mount") as { path: string; props: unknown; stream: string }[];
    expect(mounts).toHaveLength(1);
    expect(mounts[0]).toMatchObject({ type: "mount", path: "/chat/main", props: { topic: "x" } });
    expect(typeof mounts[0]?.stream).toBe("string"); // still names the stream
    expect(handle.instance).toBe("inst/chat/main");
  });

  it("mounts in DIFFERENT ticks send two unbatched `mount`s, no batch", async () => {
    const { conn, of } = makeBatchConn();
    await conn.mountSlot("/card/0", {}); // await → the flush completes this tick
    await conn.mountSlot("/card/1", {}); // enqueued in a later tick → its own flush
    expect(of("mount")).toHaveLength(2);
    expect(of("mount-batch")).toHaveLength(0);
  });
});

describe("release/mount pair cancellation (ADR 0002 item 12)", () => {
  /** A connection whose control mounts answer with a per-path instance id. */
  function makePairConn() {
    const control: Record<string, unknown>[] = [];
    const redirects: string[] = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      if (String(url).endsWith("/__rpxd/control")) {
        if (body) control.push(body);
        // A mount answers with an instance id derived from the path, so a warm
        // re-mount of the same path (across ticks) resolves to the same id.
        if (body?.type === "mount") return Response.json({ instance: `inst${body.path}`, seq: 1 });
        return new Response(null, { status: 204 });
      }
      return new Response(null, { status: 202 });
    }) as typeof fetch;
    const conn = new LiveConnection<{ items: string[] }>({
      instance: "i1",
      bootstrap,
      fetchImpl,
      onRedirect: (loc) => redirects.push(loc),
      eventSource: (url) => new FakeEventSource(url),
    });
    conn.connect();
    const source = () => FakeEventSource.instances.at(-1) as FakeEventSource;
    source().emit("open");
    const typed = (t: string) => control.filter((b) => b?.type === t);
    return { conn, control, typed, redirects, source };
  }

  it("(a) same-tick release+mount, same props → ZERO control messages, rebinds the same store", async () => {
    const { conn, typed, source } = makePairConn();
    const slot = await conn.mountSlot<{ items: string[] }>("/chat/main", { topic: "x" });
    source().emit(
      "env",
      JSON.stringify({
        seq: 1,
        instance: "inst/chat/main",
        full: { state: { items: ["s"] }, session: {} },
      }),
    );
    const releasesBefore = typed("release").length;
    const mountsBefore = typed("mount").length;
    const urlsBefore = typed("url").length;

    // A React remount across a keyed page swap: the unmounting slot releases and
    // the next page's slot mounts the SAME identity, in one tick.
    slot.release();
    const rebound = await conn.mountSlot<{ items: string[] }>("/chat/main", { topic: "x" });

    // Nothing new on the wire — release cancelled the mount and props matched.
    expect(typed("release")).toHaveLength(releasesBefore);
    expect(typed("mount")).toHaveLength(mountsBefore);
    expect(typed("mount-batch")).toHaveLength(0);
    expect(typed("url")).toHaveLength(urlsBefore);
    // The rebound handle wraps the SAME live instance + store (state survived).
    expect(rebound.instance).toBe("inst/chat/main");
    expect(rebound.store).toBe(slot.store);
    expect(rebound.store.snapshot().state).toEqual({ items: ["s"] });
    // Envelopes still dispatch to the surviving store.
    source().emit(
      "env",
      JSON.stringify({
        seq: 2,
        instance: "inst/chat/main",
        patches: [{ op: "add", path: ["items", 1], value: "t" }],
      }),
    );
    expect(rebound.store.snapshot().state.items).toEqual(["s", "t"]);
  });

  it("(b) same-tick release+mount, CHANGED props → zero mount/release, exactly one url patch", async () => {
    const { conn, typed } = makePairConn();
    const slot = await conn.mountSlot<{ items: string[] }>("/chat/main", { tools: ["a"] });
    const releasesBefore = typed("release").length;
    const mountsBefore = typed("mount").length;

    slot.release();
    await conn.mountSlot<{ items: string[] }>("/chat/main", { tools: ["b"] }); // new page's tools

    // The stale-capability fix: no release, no mount, but exactly one url patch
    // forwarding the new props so the shared slot doesn't keep the old page's.
    expect(typed("release")).toHaveLength(releasesBefore);
    expect(typed("mount")).toHaveLength(mountsBefore);
    expect(typed("url")).toEqual([
      { type: "url", instance: "inst/chat/main", props: { tools: ["b"] } },
    ]);
  });

  it("(c) across ticks → release then mount, ordered (no cancellation)", async () => {
    const { conn, control } = makePairConn();
    const slot = await conn.mountSlot<{ items: string[] }>("/chat/main", {});
    slot.release();
    await tick(); // the release flushes on its own — no mount to pair with
    await conn.mountSlot<{ items: string[] }>("/chat/main", {}); // later tick → its own flush

    const releaseIdx = control.findIndex((b) => b?.type === "release");
    const secondMountIdx = control.map((b) => b?.type).lastIndexOf("mount");
    expect(releaseIdx).toBeGreaterThanOrEqual(0);
    expect(releaseIdx).toBeLessThan(secondMountIdx); // release went out before the re-mount
  });

  it("(d) same-tick release of path A + mount of path B → both go out, no cross-cancellation", async () => {
    const { conn, typed } = makePairConn();
    const slotA = await conn.mountSlot<{ items: string[] }>("/chat/a", {});
    const releasesBefore = typed("release").length;

    slotA.release();
    const slotB = await conn.mountSlot<{ items: string[] }>("/chat/b", {});

    // Different paths never pair: A's release AND B's (unbatched) mount both send.
    expect(typed("release").length).toBe(releasesBefore + 1);
    expect(typed("release").at(-1)).toMatchObject({ type: "release", instance: "inst/chat/a" });
    expect(typed("mount")).toContainEqual(
      expect.objectContaining({ type: "mount", path: "/chat/b" }),
    );
    expect(typed("mount-batch")).toHaveLength(0); // a lone survivor stays unbatched
    expect(slotB.instance).toBe("inst/chat/b");
  });

  it("(e) normal unmount with no remount → release sent on the next flush", async () => {
    const { conn, typed } = makePairConn();
    const slot = await conn.mountSlot<{ items: string[] }>("/chat/main", {});
    const releasesBefore = typed("release").length;
    slot.release();
    expect(typed("release").length).toBe(releasesBefore); // deferred — not yet
    await tick();
    expect(typed("release").length).toBe(releasesBefore + 1);
    expect(typed("release").at(-1)).toMatchObject({ type: "release", instance: "inst/chat/main" });
  });

  it("(f) a rebound handle's onDeny fires on a runtime deny (sink rewired)", async () => {
    const { conn, source, redirects } = makePairConn();
    const slot = await conn.mountSlot("/chat/main", { topic: "x" });
    const stale: string[] = [];
    slot.onDeny((loc) => stale.push(loc)); // the releasing caller's sink

    slot.release();
    const rebound = await conn.mountSlot("/chat/main", { topic: "x" });
    const fresh: string[] = [];
    rebound.onDeny((loc) => fresh.push(loc)); // the remounting caller's sink

    // A runtime deny for the shared instance must fire the NEW caller's sink,
    // never the stale one nor the app-level redirect.
    source().emit(
      "env",
      JSON.stringify({ seq: 0, instance: "inst/chat/main", redirect: "/login" }),
    );
    expect(fresh).toEqual(["/login"]);
    expect(stale).toEqual([]);
    expect(redirects).toEqual([]);
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
