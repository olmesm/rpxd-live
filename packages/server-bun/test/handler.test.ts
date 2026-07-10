import {
  type Envelope,
  type LiveDefinition,
  memory,
  type PROTOCOL_VERSION,
  redirect,
} from "@rpxd/core";
import { describe, expect, it } from "vitest";
import { signSessionId } from "../src/cookie.ts";
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

  it("marks the session cookie Secure by default (B1)", async () => {
    const handler = makeHandler();
    const cookie = (await handler.fetch(new Request(`${base}/org/7/board`))).headers.get(
      "set-cookie",
    );
    expect(cookie).toContain("rpxd_sid=");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    await handler.dispose();
  });

  it("omits Secure when cookie.secure is false (local-http dev opt-out)", async () => {
    const handler = makeHandler({ cookie: { secure: false } });
    const cookie = (await handler.fetch(new Request(`${base}/org/7/board`))).headers.get(
      "set-cookie",
    );
    expect(cookie).toContain("rpxd_sid=");
    expect(cookie).not.toContain("Secure");
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

  it("awaits the first patch: an await-before-patch loader carries data in first paint (§12)", async () => {
    interface FeedState {
      rows: string[];
      loading: boolean;
    }
    // No synchronous projection — the loader awaits before its first patch, so
    // the renderer waits for that patch and the first document is data-complete
    // (crawlable). Emergent from loader shape (§12), no flag.
    const feedDef: LiveDefinition<FeedState, "/feed", Record<string, unknown>> = {
      setup: () => ({ rows: [] as string[], loading: false }),
      load: async (_url, ctx) => {
        await new Promise((r) => setTimeout(r, 20));
        ctx.patchState((s) => {
          s.rows = ["a", "b"];
          s.loading = false;
        });
      },
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

describe("origin policy — cross-site control-plane defense (#52)", () => {
  const CROSS = { ...COOKIE, origin: "http://evil.example" };
  const SAME = { ...COOKIE, origin: base }; // base === request origin → same-origin

  async function mount(handler: ReturnType<typeof makeHandler>, headers: Record<string, string>) {
    return handler.fetch(
      new Request(`${base}/__rpxd/control`, {
        method: "POST",
        headers,
        body: JSON.stringify({ type: "mount", path: "/org/9/board" }),
      }),
    );
  }

  it("rejects a cross-origin control POST with 403 (before authenticate)", async () => {
    let authRan = false;
    const handler = makeHandler({
      authenticate: () => {
        authRan = true;
        return {};
      },
    });
    const res = await mount(handler, CROSS);
    expect(res.status).toBe(403);
    expect(authRan).toBe(false); // origin gate runs first — auth is not a side-channel
    await handler.dispose();
  });

  it("rejects a cross-origin rpc POST and stream GET with 403", async () => {
    const handler = makeHandler();
    const rpc = await handler.fetch(
      new Request(`${base}/__rpxd/rpc`, {
        method: "POST",
        headers: CROSS,
        body: JSON.stringify({ v: V, instance: "x", rpcId: "x", calls: [] }),
      }),
    );
    expect(rpc.status).toBe(403);
    const stream = await handler.fetch(new Request(`${base}/__rpxd/stream`, { headers: CROSS }));
    expect(stream.status).toBe(403);
    await handler.dispose();
  });

  it("allows a same-origin control POST", async () => {
    const handler = makeHandler();
    const res = await mount(handler, SAME);
    expect(res.status).toBe(200);
    await handler.dispose();
  });

  it("does not origin-gate SSR GET navigation (a top-level nav is legitimately cross-site)", async () => {
    const handler = makeHandler();
    const res = await handler.fetch(
      new Request(`${base}/org/7/board`, { headers: { ...COOKIE, origin: "http://evil.example" } }),
    );
    expect(res.status).toBe(200);
    await handler.dispose();
  });

  it("allows a cross-origin request when the origin is on the allowlist", async () => {
    const handler = makeHandler({ allowedOrigins: ["http://evil.example"] });
    const res = await mount(handler, CROSS);
    expect(res.status).toBe(200);
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

describe("un-attached instance cleanup — no residual growth (#61 follow-up)", () => {
  it("prunes the empty session slice after its last instance evicts", async () => {
    // Each cookieless GET mints a fresh sid → a session slice. When its only
    // instance evicts, the slice must be dropped too, or `sessions` grows an
    // empty Map per minted sid forever under scan traffic.
    const handler = makeHandler({ warmTtlMs: 500, attachTtlMs: 10 }); // unattachedTtlMs ← 10
    for (let i = 0; i < 4; i++) {
      await handler.fetch(new Request(`${base}/org/${i}/board`)); // no cookie → new sid each
    }
    expect(handler.instanceCount).toBe(4);
    expect(handler.sessionCount).toBe(4);
    await new Promise((r) => setTimeout(r, 80)); // past unattachedTtlMs
    expect(handler.instanceCount).toBe(0);
    expect(handler.sessionCount).toBe(0); // slices pruned, not just their instances
    await handler.dispose();
  });

  it("drops a never-attached instance's snapshot on eviction (no persistent-storage leak)", async () => {
    const storage = memory();
    const handler = createRpxdHandler({
      routes: [{ path: "/org/$orgId/board", def: boardDef }],
      storage,
      warmTtlMs: 500,
      attachTtlMs: 10,
    });
    await handler.fetch(
      new Request(`${base}/org/7/board`, { headers: { cookie: "rpxd_sid=leak-x" } }),
    );
    expect(await storage.get("leak-x:/org/7/board")).toBeDefined(); // warm → persisted
    await new Promise((r) => setTimeout(r, 80));
    expect(await storage.get("leak-x:/org/7/board")).toBeUndefined(); // never adopted → row dropped
    await handler.dispose();
  });

  it("does not orphan a concurrent mount when a sibling slice is pruned mid-flight", async () => {
    // Race: mount A is suspended in its (slow) loader while sibling B's eviction
    // timer fires, empties the session slice, and prunes it from `sessions`. A
    // must still register into the *canonical* slice, not a detached reference.
    interface SlowState {
      n: number;
    }
    const slowDef: LiveDefinition<SlowState, "/slow", Record<string, unknown>> = {
      setup: () => ({ n: 0 }),
      load: async (_url, ctx) => {
        await new Promise((r) => setTimeout(r, 40)); // A stays mid-mount…
        ctx.patchState((s) => {
          s.n = 1;
        });
      },
    };
    const handler = createRpxdHandler({
      routes: [
        { path: "/org/$orgId/board", def: boardDef },
        { path: "/slow", def: slowDef },
      ],
      warmTtlMs: 500,
      attachTtlMs: 5, // unattachedTtlMs ← 5: B evicts ~5ms in, during A's 40ms load
    });
    const cookie = { cookie: "rpxd_sid=race" };
    await handler.fetch(new Request(`${base}/org/1/board`, { headers: cookie })); // B: idle, timer pending
    const aDone = handler.fetch(new Request(`${base}/slow`, { headers: cookie })); // A: slow mount
    await aDone;
    // A landed in the live session slice (pruned reference would leave it detached).
    expect(handler.instanceCount).toBe(1);
    expect(handler.sessionCount).toBe(1);
    await handler.dispose();
  });

  it("keeps an attached instance's snapshot on warm eviction (regression)", async () => {
    const storage = memory();
    const handler = createRpxdHandler({
      routes: [{ path: "/org/$orgId/board", def: boardDef }],
      storage,
      warmTtlMs: 25,
      attachTtlMs: 5,
    });
    const cookie = { cookie: "rpxd_sid=keep-x" };
    await handler.fetch(
      new Request(`${base}/__rpxd/control`, {
        method: "POST",
        headers: cookie,
        body: JSON.stringify({ type: "mount", path: "/org/2/board" }),
      }),
    );
    const abort = new AbortController();
    const streamRes = await handler.fetch(
      new Request(`${base}/__rpxd/stream`, { headers: cookie, signal: abort.signal }),
    );
    const sse = new SseReader(streamRes);
    await sse.next(); // subscribed → attached
    abort.abort();
    await new Promise((r) => setTimeout(r, 80)); // past warmTtlMs
    expect(handler.instanceCount).toBe(0);
    expect(await storage.get("keep-x:/org/2/board")).toBeDefined(); // adopted → snapshot kept
    await handler.dispose();
  });
});

describe("guard runs before setup — denied requests allocate nothing (#8)", () => {
  it("does not run setup when the guard denies", async () => {
    let setupRuns = 0;
    const guardedDef: LiveDefinition<{ ok: boolean }, "/guarded", Record<string, unknown>> = {
      setup: () => {
        setupRuns++;
        return { ok: true };
      },
      guard: () => {
        throw redirect("/login");
      },
    };
    const handler = createRpxdHandler({ routes: [{ path: "/guarded", def: guardedDef }] });
    const res = await handler.fetch(new Request(`${base}/guarded`, { headers: COOKIE }));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/login");
    expect(setupRuns).toBe(0); // guard-first: a denied principal never triggers setup/subscriptions
    expect(handler.instanceCount).toBe(0);
    await handler.dispose();
  });

  it("disposes a half-built instance when the loader redirects (no orphaned subscription)", async () => {
    let ghostReactions = 0;
    const storage = memory();
    const boomDef: LiveDefinition<{ n: number }, "/boom", Record<string, unknown>> = {
      setup: (ctx) => {
        ctx.subscribe("leak-topic"); // setup wires a subscription…
        return { n: 0 };
      },
      load: () => {
        throw redirect("/elsewhere"); // …then the loader bails out mid-mount
      },
      on: {
        ping: (state) => {
          ghostReactions++;
          state.n++;
        },
      },
    };
    const handler = createRpxdHandler({ routes: [{ path: "/boom", def: boomDef }], storage });
    const res = await handler.fetch(new Request(`${base}/boom`, { headers: COOKIE }));
    expect(res.status).toBe(302); // the loader redirect propagates
    // An orphaned (undisposed) instance would still be subscribed; a disposed one isn't.
    storage.bus.publish({
      topic: "leak-topic",
      event: "ping",
      payload: {},
      senderId: "other",
      self: false,
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(ghostReactions).toBe(0); // disposed on throw → unsubscribed → no ghost reaction
    await handler.dispose();
  });
});

describe("opt-in throttle — per-key rate limit (#6)", () => {
  const hit = (h: ReturnType<typeof makeHandler>, ip?: string) =>
    h.fetch(
      new Request(`${base}/org/7/board`, {
        headers: ip ? { ...COOKIE, "x-ip": ip } : COOKIE,
      }),
    );

  it("rejects over-limit requests for a key with 429", async () => {
    const handler = makeHandler({
      throttle: { key: (req) => req.headers.get("x-ip"), limit: { capacity: 2, refillPerSec: 0 } },
    });
    expect((await hit(handler, "1.2.3.4")).status).toBe(200);
    expect((await hit(handler, "1.2.3.4")).status).toBe(200);
    expect((await hit(handler, "1.2.3.4")).status).toBe(429); // bucket drained
    await handler.dispose();
  });

  it("does not throttle when the key returns null", async () => {
    const handler = makeHandler({
      throttle: { key: () => null, limit: { capacity: 1, refillPerSec: 0 } },
    });
    expect((await hit(handler)).status).toBe(200);
    expect((await hit(handler)).status).toBe(200); // null key bypasses the limiter
    await handler.dispose();
  });

  it("meters keys independently", async () => {
    const handler = makeHandler({
      throttle: { key: (req) => req.headers.get("x-ip"), limit: { capacity: 1, refillPerSec: 0 } },
    });
    expect((await hit(handler, "a")).status).toBe(200);
    expect((await hit(handler, "a")).status).toBe(429);
    expect((await hit(handler, "b")).status).toBe(200); // separate bucket
    await handler.dispose();
  });

  it("exempts the SSE stream — a 429 there would kill the live channel", async () => {
    const handler = makeHandler({
      throttle: { key: (req) => req.headers.get("x-ip"), limit: { capacity: 1, refillPerSec: 0 } },
    });
    expect((await hit(handler, "streamer")).status).toBe(200);
    expect((await hit(handler, "streamer")).status).toBe(429); // key drained
    // The long-lived SSE stream is never throttled (native EventSource can't
    // reconnect after a non-200), so a drained key can still open it.
    const streamRes = await handler.fetch(
      new Request(`${base}/__rpxd/stream`, { headers: { ...COOKIE, "x-ip": "streamer" } }),
    );
    expect(streamRes.status).toBe(200);
    await handler.dispose();
  });
});

describe("error disclosure — generic 500 by default (#9)", () => {
  const boomDef: LiveDefinition<{ ok: boolean }, "/boom", Record<string, unknown>> = {
    setup: () => ({ ok: true }),
    guard: () => {
      throw new Error("secret internal detail");
    },
  };

  it("returns a generic 500 body, not the internal error message", async () => {
    const handler = createRpxdHandler({ routes: [{ path: "/boom", def: boomDef }] });
    const res = await handler.fetch(new Request(`${base}/boom`, { headers: COOKIE }));
    expect(res.status).toBe(500);
    expect(await res.text()).toBe("internal error"); // no leak
    await handler.dispose();
  });

  it("echoes the message when debugErrors is enabled (dev)", async () => {
    const handler = createRpxdHandler({
      routes: [{ path: "/boom", def: boomDef }],
      debugErrors: true,
    });
    const res = await handler.fetch(new Request(`${base}/boom`, { headers: COOKIE }));
    expect(res.status).toBe(500);
    expect(await res.text()).toBe("secret internal detail");
    await handler.dispose();
  });

  it("hides authenticate error messages in the 403 by default", async () => {
    const handler = createRpxdHandler({
      routes: [{ path: "/org/$orgId/board", def: boardDef }],
      authenticate: () => {
        throw new Error("db connection string leaked");
      },
    });
    const res = await handler.fetch(new Request(`${base}/org/7/board`, { headers: COOKIE }));
    expect(res.status).toBe(403);
    expect(await res.text()).toBe("forbidden"); // no leak of the internal auth error
    await handler.dispose();
  });
});

describe("per-session instance cap (C)", () => {
  const capMount = (h: ReturnType<typeof makeHandler>, sid: string, n: number) =>
    h.fetch(
      new Request(`${base}/__rpxd/control`, {
        method: "POST",
        headers: { cookie: `rpxd_sid=${sid}` },
        body: JSON.stringify({ type: "mount", path: `/org/${n}/board` }),
      }),
    );
  const capAlive = async (h: ReturnType<typeof makeHandler>, sid: string, instance: string) =>
    (
      await h.fetch(
        new Request(`${base}/__rpxd/rpc`, {
          method: "POST",
          headers: { cookie: `rpxd_sid=${sid}` },
          body: JSON.stringify({ v: V, instance, rpcId: "p", calls: [] }),
        }),
      )
    ).status === 202;

  it("evicts the oldest idle instance when a session exceeds its cap", async () => {
    const handler = makeHandler({ maxInstancesPerSession: 3, warmTtlMs: 1000, attachTtlMs: 1000 });
    const id1 = (await (await capMount(handler, "cap-s", 1)).json()).instance as string;
    const id2 = (await (await capMount(handler, "cap-s", 2)).json()).instance as string;
    await capMount(handler, "cap-s", 3);
    expect(handler.instanceCount).toBe(3);
    const id4 = (await (await capMount(handler, "cap-s", 4)).json()).instance as string;
    expect(handler.instanceCount).toBe(3); // the 4th mount evicts the session's oldest
    expect(await capAlive(handler, "cap-s", id1)).toBe(false); // oldest gone
    expect(await capAlive(handler, "cap-s", id2)).toBe(true);
    expect(await capAlive(handler, "cap-s", id4)).toBe(true);
    await handler.dispose();
  });

  it("disables the per-session cap when null", async () => {
    const handler = makeHandler({
      maxInstancesPerSession: null,
      warmTtlMs: 1000,
      attachTtlMs: 1000,
    });
    for (let n = 1; n <= 4; n++) await capMount(handler, "nocap", n);
    expect(handler.instanceCount).toBe(4);
    await handler.dispose();
  });
});

describe("signed session cookie — HMAC integrity (B2)", () => {
  const SECRET = "unit-test-secret";

  it("signs the session cookie when a secret is configured", async () => {
    const handler = makeHandler({ sessionSecret: SECRET });
    const res = await handler.fetch(new Request(`${base}/org/7/board`));
    const value = /rpxd_sid=([^;]+)/.exec(res.headers.get("set-cookie") ?? "")?.[1] ?? "";
    expect(value).toContain("."); // <sid>.<mac>, not a bare sid
    // …and it round-trips: presenting it back resolves the same, non-new session.
    const back = handler.resolveSid(
      new Request(base, { headers: { cookie: `rpxd_sid=${value}` } }),
    );
    expect(back.isNew).toBe(false);
    await handler.dispose();
  });

  it("rejects a forged/unsigned cookie as a brand-new session", async () => {
    const handler = makeHandler({ sessionSecret: SECRET });
    const forged = handler.resolveSid(
      new Request(base, { headers: { cookie: "rpxd_sid=attacker-chosen" } }),
    );
    expect(forged.isNew).toBe(true);
    expect(forged.sid).not.toBe("attacker-chosen"); // can't pin a chosen sid (no fixation / namespace collision)
    // A validly-signed sid is accepted verbatim.
    const signed = signSessionId("real-sid", SECRET);
    expect(
      handler.resolveSid(new Request(base, { headers: { cookie: `rpxd_sid=${signed}` } })),
    ).toEqual({ sid: "real-sid", isNew: false });
    await handler.dispose();
  });

  it("leaves the sid unsigned when no secret is set (back-compat)", async () => {
    const handler = makeHandler(); // no secret
    const res = await handler.fetch(new Request(`${base}/org/7/board`));
    const value = /rpxd_sid=([^;]+)/.exec(res.headers.get("set-cookie") ?? "")?.[1] ?? "";
    expect(value).not.toContain("."); // bare uuid
    expect(
      handler.resolveSid(new Request(base, { headers: { cookie: "rpxd_sid=plain" } })),
    ).toEqual({
      sid: "plain",
      isNew: false,
    });
    await handler.dispose();
  });

  it("treats an empty-string secret as unsigned (no write/read split)", async () => {
    // "" must NOT enter verify mode (a public empty HMAC key would be forgeable);
    // it collapses to the unsigned path, consistent on write and read.
    const handler = makeHandler({ sessionSecret: "" });
    const value =
      /rpxd_sid=([^;]+)/.exec(
        (await handler.fetch(new Request(`${base}/org/7/board`))).headers.get("set-cookie") ?? "",
      )?.[1] ?? "";
    expect(value).not.toContain("."); // written unsigned…
    expect(
      handler.resolveSid(new Request(base, { headers: { cookie: "rpxd_sid=plain" } })),
    ).toEqual({ sid: "plain", isNew: false }); // …and read unsigned, not minted fresh
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
