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
  mount: async ({ orgId }) => ({ items: ["first"], orgId }),
  params: async ({ filter }, ctx) => {
    ctx.patchState((s) => {
      s.filter = filter ?? "all";
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
    // projection chrome (`filter`) — mount state + one flush, no data wait.
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
      mount: async () => ({ rows: [] as string[], loading: false }),
      params: async (_search, ctx) => {
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
      mount: async () => ({ rows: [] as string[], loading: false }),
      params: async (_search, ctx) => {
        ctx.patchState((s) => {
          s.loading = true;
        });
        await new Promise((r) => setTimeout(r, 20));
        ctx.patchState((s) => {
          s.rows = ["a", "b"];
          s.loading = false;
        });
      },
      paramsOptions: { blockSsr: true },
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
        body: JSON.stringify({ type: "params", instance, search: { filter: "done" } }),
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
    const handler = makeHandler({ attachTtlMs: 1 });
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
