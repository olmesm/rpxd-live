import type { Envelope, LiveDefinition, PROTOCOL_VERSION } from "@rpxd/core";
import { describe, expect, it } from "vitest";
import { createRpxdHandler } from "../src/handler.ts";
import { matchPath, matchRoute } from "../src/match.ts";

interface BoardState {
  items: string[];
  orgId: string;
  filter?: string;
}

const boardDef: LiveDefinition<BoardState, "/org/$orgId/board", Record<string, unknown>> = {
  setup: (ctx) => ({ items: ["first"], orgId: ctx.params.orgId }),
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

const V = 1 as typeof PROTOCOL_VERSION;
const COOKIE = { cookie: "rpxd_sid=session-a" };

function makeHandler(
  overrides: Parameters<typeof createRpxdHandler>[0] extends infer O
    ? Partial<O & object>
    : never = {},
) {
  return createRpxdHandler({
    routes: [{ path: "/org/$orgId/board", def: boardDef }],
    warmTtlMs: 15,
    attachTtlMs: 60,
    ...overrides,
  });
}

/** Incremental SSE parser over a streaming Response. */
class SseReader {
  #reader: ReadableStreamDefaultReader<Uint8Array>;
  #decoder = new TextDecoder();
  #buf = "";
  #queue: Envelope[] = [];
  #pendingRead: ReturnType<ReadableStreamDefaultReader<Uint8Array>["read"]> | undefined;

  constructor(res: Response) {
    this.#reader = (res.body as ReadableStream<Uint8Array>).getReader();
  }

  async next(timeoutMs = 700): Promise<Envelope | null> {
    const deadline = Date.now() + timeoutMs;
    while (this.#queue.length === 0) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return null;
      const read = this.#pendingRead ?? this.#reader.read();
      const result = await Promise.race([
        read,
        new Promise<"timeout">((r) => setTimeout(() => r("timeout"), remaining)),
      ]);
      if (result === "timeout") {
        this.#pendingRead = read; // keep the in-flight read; drop nothing
        return null;
      }
      this.#pendingRead = undefined;
      if (result.done) return null;
      this.#buf += this.#decoder.decode(result.value);
      let idx = this.#buf.indexOf("\n\n");
      while (idx !== -1) {
        const chunk = this.#buf.slice(0, idx);
        this.#buf = this.#buf.slice(idx + 2);
        const data = chunk.split("\n").find((l) => l.startsWith("data: "));
        if (data) this.#queue.push(JSON.parse(data.slice(6)) as Envelope);
        idx = this.#buf.indexOf("\n\n");
      }
    }
    return this.#queue.shift() as Envelope;
  }
}

const base = "http://test.local";

describe("matchPath / matchRoute", () => {
  it("captures $params and rejects mismatches", () => {
    expect(matchPath("/org/$orgId/board", "/org/42/board")).toEqual({ orgId: "42" });
    expect(matchPath("/org/$orgId/board", "/org/42/list")).toBeNull();
    expect(matchPath("/", "/")).toEqual({});
  });

  it("prefers static routes over params", () => {
    expect(matchRoute(["/$slug", "/about"], "/about")?.path).toBe("/about");
    expect(matchRoute(["/$slug", "/about"], "/other")?.path).toBe("/$slug");
  });
});

describe("SSR mount (§12)", () => {
  it("mounts during SSR and embeds { snapshot, seq, attachToken }", async () => {
    const handler = makeHandler();
    const res = await handler.fetch(new Request(`${base}/org/7/board`, { headers: COOKIE }));
    expect(res.status).toBe(200);
    const html = await res.text();
    const json = /<script id="__rpxd" type="application\/json">(.*?)<\/script>/s.exec(html)?.[1];
    const boot = JSON.parse(json as string);
    // Stream-default SSR (§12): first paint carries the loader's synchronous
    // projection chrome (`filter`) — setup state + one flush, no data wait.
    expect(boot.snapshot.state).toEqual({ items: ["first"], orgId: "7", filter: "all" });
    expect(boot.seq).toBe(2);
    expect(boot.attachToken).toBeTruthy();
    expect(boot.params).toEqual({ orgId: "7" });
    await handler.dispose();
  });

  it("sets the session cookie on first contact", async () => {
    const handler = makeHandler();
    const res = await handler.fetch(new Request(`${base}/org/7/board`));
    expect(res.headers.get("set-cookie")).toContain("rpxd_sid=");
    await handler.dispose();
  });

  it("streams by default: the awaited data is NOT in the first paint (§12)", async () => {
    interface FeedState {
      rows: string[];
      loading: boolean;
    }
    const feedDef: LiveDefinition<FeedState, "/feed", Record<string, unknown>> = {
      setup: () => ({ rows: [] as string[], loading: false }),
      load: async (_url, ctx) => {
        ctx.patchState((s) => {
          s.loading = true; // synchronous projection — lands in first paint
        });
        await new Promise((r) => setTimeout(r, 20));
        ctx.patchState((s) => {
          s.rows = ["a", "b"]; // awaited data — streams after hydration
          s.loading = false;
        });
      },
    };
    const handler = createRpxdHandler({ routes: [{ path: "/feed", def: feedDef }] });
    const res = await handler.fetch(new Request(`${base}/feed`, { headers: COOKIE }));
    const html = await res.text();
    const json = /<script id="__rpxd" type="application\/json">(.*?)<\/script>/s.exec(html)?.[1];
    const boot = JSON.parse(json as string);
    expect(boot.snapshot.state).toEqual({ rows: [], loading: true });
    await handler.dispose();
  });

  it("blockSsr awaits the loader so first paint carries data (§12)", async () => {
    interface FeedState {
      rows: string[];
      loading: boolean;
    }
    const feedDef: LiveDefinition<FeedState, "/feed", Record<string, unknown>> = {
      setup: () => ({ rows: [] as string[], loading: false }),
      load: async (_url, ctx) => {
        ctx.patchState((s) => {
          s.loading = true;
        });
        await new Promise((r) => setTimeout(r, 20));
        ctx.patchState((s) => {
          s.rows = ["a", "b"];
          s.loading = false;
        });
      },
      loadOptions: { blockSsr: true },
    };
    const handler = createRpxdHandler({ routes: [{ path: "/feed", def: feedDef }] });
    const res = await handler.fetch(new Request(`${base}/feed`, { headers: COOKIE }));
    const html = await res.text();
    const json = /<script id="__rpxd" type="application\/json">(.*?)<\/script>/s.exec(html)?.[1];
    const boot = JSON.parse(json as string);
    expect(boot.snapshot.state).toEqual({ rows: ["a", "b"], loading: false });
    await handler.dispose();
  });

  it("404s unknown routes and 403s rejected auth", async () => {
    const handler = makeHandler({
      authenticate: (req: Request) => {
        if (req.headers.get("x-deny")) throw new Error("nope");
        return {};
      },
    });
    expect((await handler.fetch(new Request(`${base}/nowhere`, { headers: COOKIE }))).status).toBe(
      404,
    );
    expect(
      (
        await handler.fetch(
          new Request(`${base}/org/7/board`, { headers: { ...COOKIE, "x-deny": "1" } }),
        )
      ).status,
    ).toBe(403);
    await handler.dispose();
  });
});

describe("stream + rpc + control (§11)", () => {
  it("delivers full snapshot on stream open, then rpc acks as patches", async () => {
    const handler = makeHandler();
    const mountRes = await handler.fetch(
      new Request(`${base}/__rpxd/control`, {
        method: "POST",
        headers: COOKIE,
        body: JSON.stringify({ type: "mount", path: "/org/9/board" }),
      }),
    );
    const { instance } = await mountRes.json();

    const streamRes = await handler.fetch(
      new Request(`${base}/__rpxd/stream`, { headers: COOKIE }),
    );
    const sse = new SseReader(streamRes);
    const full = await sse.next();
    expect(full?.full).toBeDefined();
    expect((full?.full?.state as BoardState).orgId).toBe("9");

    const rpcRes = await handler.fetch(
      new Request(`${base}/__rpxd/rpc`, {
        method: "POST",
        headers: COOKIE,
        body: JSON.stringify({
          v: V,
          instance,
          rpcId: "r1",
          calls: [{ rpc: "add", payload: { item: "second" } }],
        }),
      }),
    );
    expect(rpcRes.status).toBe(202);
    const ack = await sse.next();
    expect(ack?.rpcId).toBe("r1");
    expect(ack?.patches?.[0]).toEqual({ op: "add", path: ["items", 1], value: "second" });
    await handler.dispose();
  });

  it("refuses rpc/control against another session's instance id (IDOR)", async () => {
    const handler = makeHandler();
    const owner = { cookie: "rpxd_sid=owner" };
    const attacker = { cookie: "rpxd_sid=attacker" };

    const mountRes = await handler.fetch(
      new Request(`${base}/__rpxd/control`, {
        method: "POST",
        headers: owner,
        body: JSON.stringify({ type: "mount", path: "/org/9/board" }),
      }),
    );
    const { instance } = await mountRes.json();

    // A different session must not be able to drive the owner's instance.
    const rpcRes = await handler.fetch(
      new Request(`${base}/__rpxd/rpc`, {
        method: "POST",
        headers: attacker,
        body: JSON.stringify({
          v: V,
          instance,
          rpcId: "x",
          calls: [{ rpc: "add", payload: { item: "pwned" } }],
        }),
      }),
    );
    expect(rpcRes.status).toBe(404);

    const ctlRes = await handler.fetch(
      new Request(`${base}/__rpxd/control`, {
        method: "POST",
        headers: attacker,
        body: JSON.stringify({ type: "resync", instance }),
      }),
    );
    expect(ctlRes.status).toBe(404);
    await handler.dispose();
  });

  it("routes params control to the session slice", async () => {
    const handler = makeHandler();
    const mountRes = await handler.fetch(
      new Request(`${base}/__rpxd/control`, {
        method: "POST",
        headers: COOKIE,
        body: JSON.stringify({ type: "mount", path: "/org/9/board" }),
      }),
    );
    const { instance } = await mountRes.json();
    const streamRes = await handler.fetch(
      new Request(`${base}/__rpxd/stream`, { headers: COOKIE }),
    );
    const sse = new SseReader(streamRes);
    await sse.next(); // full

    await handler.fetch(
      new Request(`${base}/__rpxd/control`, {
        method: "POST",
        headers: COOKIE,
        body: JSON.stringify({ type: "url", instance, search: { filter: "done" } }),
      }),
    );
    const env = await sse.next();
    // The loader writes page state (§7) — patches land on the page, not $session.
    expect(env?.patches?.[0]?.path).toEqual(["filter"]);
    await handler.dispose();
  });

  it("resyncs on demand and 404s unknown instances", async () => {
    const handler = makeHandler();
    const res = await handler.fetch(
      new Request(`${base}/__rpxd/rpc`, {
        method: "POST",
        headers: COOKIE,
        body: JSON.stringify({ v: V, instance: "ghost", rpcId: "x", calls: [] }),
      }),
    );
    expect(res.status).toBe(404);
    await handler.dispose();
  });
});

describe("SSR attach adoption (§12)", () => {
  async function ssrBoot(handler: ReturnType<typeof makeHandler>) {
    const res = await handler.fetch(new Request(`${base}/org/5/board`, { headers: COOKIE }));
    const html = await res.text();
    const json = /<script id="__rpxd" type="application\/json">(.*?)<\/script>/s.exec(html)?.[1];
    return JSON.parse(json as string) as {
      instance: string;
      seq: number;
      attachToken: string;
    };
  }

  it("adopts the warm instance within TTL — no re-mount, no full snapshot", async () => {
    const handler = makeHandler();
    const boot = await ssrBoot(handler);
    expect(handler.instanceCount).toBe(1);

    const streamRes = await handler.fetch(
      new Request(`${base}/__rpxd/stream?attach=${boot.attachToken}&seq=${boot.seq}`, {
        headers: COOKIE,
      }),
    );
    const sse = new SseReader(streamRes);
    const first = await sse.next(150);
    expect(first).toBeNull(); // adopted: stream resumes from seq, nothing to send
    expect(handler.instanceCount).toBe(1); // same instance, not re-mounted

    // rpc continues the seq from the SSR snapshot
    await handler.fetch(
      new Request(`${base}/__rpxd/rpc`, {
        method: "POST",
        headers: COOKIE,
        body: JSON.stringify({
          v: V,
          instance: boot.instance,
          rpcId: "r2",
          calls: [{ rpc: "add", payload: { item: "post-attach" } }],
        }),
      }),
    );
    const ack = await sse.next();
    expect(ack?.seq).toBe(boot.seq + 1);
    await handler.dispose();
  });

  it("falls back to a full snapshot when the token is stale", async () => {
    // Token expires fast (attachTtlMs), but the un-attached instance must stay
    // warm long enough for the late client to still find it (#61) — so give
    // unattachedTtlMs headroom over the token.
    const handler = makeHandler({ attachTtlMs: 1, unattachedTtlMs: 200 });
    const boot = await ssrBoot(handler);
    await new Promise((r) => setTimeout(r, 10)); // let the token expire

    const streamRes = await handler.fetch(
      new Request(`${base}/__rpxd/stream?attach=${boot.attachToken}&seq=${boot.seq}`, {
        headers: COOKIE,
      }),
    );
    const sse = new SseReader(streamRes);
    const first = await sse.next();
    expect(first?.full).toBeDefined(); // silent recovery via full snapshot
    await handler.dispose();
  });
});

describe("eviction (§11)", () => {
  it("snapshots + evicts after the warm TTL when subscribers reach 0", async () => {
    const handler = makeHandler({ warmTtlMs: 15, attachTtlMs: 5 });
    await handler.fetch(
      new Request(`${base}/__rpxd/control`, {
        method: "POST",
        headers: COOKIE,
        body: JSON.stringify({ type: "mount", path: "/org/2/board" }),
      }),
    );
    expect(handler.instanceCount).toBe(1);
    await new Promise((r) => setTimeout(r, 60));
    expect(handler.instanceCount).toBe(0);
    await handler.dispose();
  });

  it("keeps the instance while a stream is subscribed, evicts after abort", async () => {
    const handler = makeHandler({ warmTtlMs: 15, attachTtlMs: 5 });
    await handler.fetch(
      new Request(`${base}/__rpxd/control`, {
        method: "POST",
        headers: COOKIE,
        body: JSON.stringify({ type: "mount", path: "/org/3/board" }),
      }),
    );
    const abort = new AbortController();
    const streamRes = await handler.fetch(
      new Request(`${base}/__rpxd/stream`, { headers: COOKIE, signal: abort.signal }),
    );
    const sse = new SseReader(streamRes);
    await sse.next(); // subscribed
    await new Promise((r) => setTimeout(r, 40));
    expect(handler.instanceCount).toBe(1); // stream holds it warm

    abort.abort();
    await new Promise((r) => setTimeout(r, 60));
    expect(handler.instanceCount).toBe(0);
    await handler.dispose();
  });
});

describe("un-attached instance bounds — cookieless GET flood (#61)", () => {
  const mount = (handler: ReturnType<typeof makeHandler>, sid: string, path = "/org/1/board") =>
    handler.fetch(
      new Request(`${base}/__rpxd/control`, {
        method: "POST",
        headers: { cookie: `rpxd_sid=${sid}` },
        body: JSON.stringify({ type: "mount", path }),
      }),
    );
  /** Read-only liveness probe: 202 = instance still owned/live, 404 = evicted. */
  const alive = async (handler: ReturnType<typeof makeHandler>, sid: string, instance: string) => {
    const res = await handler.fetch(
      new Request(`${base}/__rpxd/rpc`, {
        method: "POST",
        headers: { cookie: `rpxd_sid=${sid}` },
        body: JSON.stringify({ v: V, instance, rpcId: "probe", calls: [] }),
      }),
    );
    return res.status === 202;
  };

  it("evicts a never-attached instance on the short unattachedTtlMs, not warmTtlMs", async () => {
    // A cookieless GET warms an instance no client ever attaches to. It must not
    // linger for the full warm-TTL — the un-attached hold is the attach window.
    const handler = makeHandler({ warmTtlMs: 500, attachTtlMs: 10 }); // unattachedTtlMs ← attachTtlMs
    await handler.fetch(
      new Request(`${base}/org/7/board`, { headers: { cookie: "rpxd_sid=ttl-anon" } }),
    );
    expect(handler.instanceCount).toBe(1);
    await new Promise((r) => setTimeout(r, 80)); // past unattachedTtlMs(10), well under warmTtlMs(500)
    expect(handler.instanceCount).toBe(0);
    await handler.dispose();
  });

  it("keeps an attached instance for the full warmTtlMs after its stream aborts", async () => {
    // Once a real client has attached, the instance earns the long warm-TTL —
    // the short un-attached TTL must not apply to it.
    const handler = makeHandler({ warmTtlMs: 300, attachTtlMs: 10 });
    const abort = new AbortController();
    await mount(handler, "ttl-real", "/org/3/board");
    const streamRes = await handler.fetch(
      new Request(`${base}/__rpxd/stream`, {
        headers: { cookie: "rpxd_sid=ttl-real" },
        signal: abort.signal,
      }),
    );
    const sse = new SseReader(streamRes);
    await sse.next(); // subscribed → attached
    abort.abort();
    await new Promise((r) => setTimeout(r, 80)); // past unattachedTtlMs, under warmTtlMs(300)
    expect(handler.instanceCount).toBe(1); // survives on the warm TTL
    await handler.dispose();
  });

  it("caps concurrent never-attached instances, evicting the oldest", async () => {
    const handler = makeHandler({
      warmTtlMs: 1000,
      attachTtlMs: 1000,
      maxUnattachedInstances: 2,
    });
    const a = (await (await mount(handler, "cap-a")).json()).instance as string;
    const b = (await (await mount(handler, "cap-b")).json()).instance as string;
    expect(handler.instanceCount).toBe(2);
    const c = (await (await mount(handler, "cap-c")).json()).instance as string;
    expect(handler.instanceCount).toBe(2); // the 3rd evicts the oldest un-attached
    expect(await alive(handler, "cap-a", a)).toBe(false); // oldest gone
    expect(await alive(handler, "cap-b", b)).toBe(true);
    expect(await alive(handler, "cap-c", c)).toBe(true);
    await handler.dispose();
  });

  it("treats the cap as LRU — a warm re-mount bumps recency", async () => {
    const handler = makeHandler({
      warmTtlMs: 1000,
      attachTtlMs: 1000,
      maxUnattachedInstances: 2,
    });
    const a = (await (await mount(handler, "lru-a")).json()).instance as string;
    const b = (await (await mount(handler, "lru-b")).json()).instance as string;
    // Warm re-mount of `a` (same sid+path) reuses it AND bumps it to most-recent.
    const aAgain = (await (await mount(handler, "lru-a")).json()).instance as string;
    expect(aAgain).toBe(a); // warm reuse, not a fresh instance
    const c = (await (await mount(handler, "lru-c")).json()).instance as string;
    expect(handler.instanceCount).toBe(2);
    expect(await alive(handler, "lru-b", b)).toBe(false); // b is now the LRU → evicted
    expect(await alive(handler, "lru-a", a)).toBe(true); // bumped → survives
    expect(await alive(handler, "lru-c", c)).toBe(true);
    await handler.dispose();
  });

  it("disables the cap when maxUnattachedInstances is null", async () => {
    const handler = makeHandler({
      warmTtlMs: 1000,
      attachTtlMs: 1000,
      maxUnattachedInstances: null,
    });
    await mount(handler, "off-a");
    await mount(handler, "off-b");
    await mount(handler, "off-c");
    expect(handler.instanceCount).toBe(3); // no bound
    await handler.dispose();
  });
});

describe("tier-2 soft reload — late mount over the live stream (§7)", () => {
  const stream = (id: string) =>
    new Request(`${base}/__rpxd/stream?stream=${id}`, { headers: COOKIE });
  const control = (body: unknown, signal?: AbortSignal) =>
    new Request(`${base}/__rpxd/control`, {
      method: "POST",
      headers: COOKIE,
      body: JSON.stringify(body),
      signal,
    });

  it("subscribes a newly-mounted instance to the open stream via its stream id", async () => {
    const handler = makeHandler();
    // Stream opens first (session empty), then a same-route path mount joins it.
    const sse = new SseReader(await handler.fetch(stream("s1")));
    const mountRes = await handler.fetch(
      control({ type: "mount", path: "/org/7/board", stream: "s1" }),
    );
    const { instance } = await mountRes.json();
    // The new instance's snapshot arrives on the already-open stream — no reconnect.
    const full = await sse.next();
    expect(full?.instance).toBe(instance);
    expect(full?.full).toBeDefined();
    expect((full?.full?.state as BoardState).orgId).toBe("7");
    await handler.dispose();
  });

  it("release unsubscribes the abandoned instance so it evicts; the live one stays", async () => {
    const handler = makeHandler({ warmTtlMs: 15, attachTtlMs: 5 });
    const abort = new AbortController();
    const sse = new SseReader(await handler.fetch(stream("s1")));

    const m1 = await handler.fetch(control({ type: "mount", path: "/org/1/board", stream: "s1" }));
    const { instance: first } = await m1.json();
    await sse.next(); // first full
    await handler.fetch(control({ type: "mount", path: "/org/2/board", stream: "s1" }));
    await sse.next(); // second full
    expect(handler.instanceCount).toBe(2);

    // Abandon the first (tier-2 forward nav): release it from this stream.
    const rel = await handler.fetch(control({ type: "release", instance: first, stream: "s1" }));
    expect(rel.status).toBe(204);
    await new Promise((r) => setTimeout(r, 40));
    expect(handler.instanceCount).toBe(1); // released one evicted, the live one held

    abort.abort();
    await handler.dispose();
  });

  it("late-mount subscription is idempotent (a warm re-join does not double-send)", async () => {
    const handler = makeHandler();
    const sse = new SseReader(await handler.fetch(stream("s1")));
    await handler.fetch(control({ type: "mount", path: "/org/4/board", stream: "s1" }));
    await sse.next(); // full from the first join
    // A second mount of the same path (warm reuse) must not re-subscribe.
    await handler.fetch(control({ type: "mount", path: "/org/4/board", stream: "s1" }));
    // No second full for the same instance on this stream.
    expect(await sse.next(120)).toBeNull();
    expect(handler.instanceCount).toBe(1);
    await handler.dispose();
  });
});
