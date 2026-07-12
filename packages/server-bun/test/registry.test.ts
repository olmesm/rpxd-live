/**
 * Instance-registry hardening: the per-session cap as a hard ceiling for
 * subscribed instances, twin-mount identity safety, stream-cleanup re-arm
 * from the live registry, and WS mount redirect envelopes.
 */
import {
  type Envelope,
  type LiveDefinition,
  memory,
  type PROTOCOL_VERSION,
  type RpxdDiagnostic,
  redirect,
} from "@rpxd/core";
import { describe, expect, it } from "vitest";
import { createRpxdHandler } from "../src/handler.ts";

interface BoardState {
  items: string[];
  orgId: string;
}

const boardDef: LiveDefinition<BoardState, "/org/$orgId/board", Record<string, unknown>> = {
  setup: (ctx) => ({ items: ["first"], orgId: ctx.params.orgId }),
};

const V = 1 as typeof PROTOCOL_VERSION;
const base = "http://test.local";

function makeHandler(
  overrides: Parameters<typeof createRpxdHandler>[0] extends infer O
    ? Partial<O & object>
    : never = {},
) {
  return createRpxdHandler({
    routes: [{ path: "/org/$orgId/board", def: boardDef }],
    warmTtlMs: 1000,
    attachTtlMs: 1000,
    // S1: signing is on by default, and vitest runs NODE_ENV=development (see
    // vitest.config.ts), so a bare handler would otherwise get an ephemeral
    // per-instance secret — the fixed literal `cookieOf(sid)` cookies this
    // file uses to simulate stable sessions across requests would no longer
    // verify. This suite doesn't test cookie signing, so opt into the explicit
    // unsigned escape hatch.
    cookie: { sign: false },
    ...overrides,
  });
}

const cookieOf = (sid: string) => ({ cookie: `rpxd_sid=${sid}` });

const mount = (h: ReturnType<typeof makeHandler>, sid: string, path: string, stream?: string) =>
  h.fetch(
    new Request(`${base}/__rpxd/control`, {
      method: "POST",
      headers: cookieOf(sid),
      body: JSON.stringify({ type: "mount", path, ...(stream ? { stream } : {}) }),
    }),
  );

const openStream = (
  h: ReturnType<typeof makeHandler>,
  sid: string,
  streamId: string,
  signal?: AbortSignal,
) =>
  h.fetch(
    new Request(`${base}/__rpxd/stream?stream=${streamId}`, { headers: cookieOf(sid), signal }),
  );

/** Read-only liveness probe: 202 = instance still owned/live, 404 = evicted. */
const alive = async (h: ReturnType<typeof makeHandler>, sid: string, instance: string) =>
  (
    await h.fetch(
      new Request(`${base}/__rpxd/rpc`, {
        method: "POST",
        headers: cookieOf(sid),
        body: JSON.stringify({ v: V, instance, rpcId: "p", calls: [] }),
      }),
    )
  ).status === 202;

describe("per-session cap — a hard ceiling even when every instance is subscribed", () => {
  it("rejects the N+1th fresh mount with 429 when every held instance is subscribed", async () => {
    const events: RpxdDiagnostic[] = [];
    const handler = makeHandler({
      maxInstancesPerSession: 2,
      onDiagnostic: (e) => events.push(e),
    });
    const abort = new AbortController();
    await openStream(handler, "hard-cap", "s1", abort.signal);
    expect((await mount(handler, "hard-cap", "/org/1/board", "s1")).status).toBe(200);
    expect((await mount(handler, "hard-cap", "/org/2/board", "s1")).status).toBe(200);
    // Both instances ride the open stream (subscribed) — nothing is evictable,
    // so the 3rd fresh mount must be rejected, not registered past the cap.
    const res = await mount(handler, "hard-cap", "/org/3/board", "s1");
    expect(res.status).toBe(429);
    expect(handler.instanceCount).toBe(2);
    expect(events.map((e) => e.type)).toContain("cap-rejected");
    abort.abort();
    await handler.dispose();
  });

  it("still warm-remounts an already-held path at the cap", async () => {
    const handler = makeHandler({ maxInstancesPerSession: 2 });
    const abort = new AbortController();
    await openStream(handler, "warm-cap", "s1", abort.signal);
    const first = (await (await mount(handler, "warm-cap", "/org/1/board", "s1")).json())
      .instance as string;
    await mount(handler, "warm-cap", "/org/2/board", "s1");
    // At the cap, a legit tab revisiting a held path must reuse it, not 429.
    const res = await mount(handler, "warm-cap", "/org/1/board", "s1");
    expect(res.status).toBe(200);
    expect(((await res.json()) as { instance: string }).instance).toBe(first);
    abort.abort();
    await handler.dispose();
  });

  it("evicts an idle instance to make room before rejecting", async () => {
    const handler = makeHandler({ maxInstancesPerSession: 2 });
    const abort = new AbortController();
    await openStream(handler, "idle-cap", "s1", abort.signal);
    // /org/1 is registered but never joined to the stream → idle (evictable).
    const idle = (await (await mount(handler, "idle-cap", "/org/1/board")).json())
      .instance as string;
    await mount(handler, "idle-cap", "/org/2/board", "s1");
    const res = await mount(handler, "idle-cap", "/org/3/board", "s1");
    expect(res.status).toBe(200); // idle slot freed, mount admitted
    expect(handler.instanceCount).toBe(2);
    expect(await alive(handler, "idle-cap", idle)).toBe(false); // the idle one made room
    abort.abort();
    await handler.dispose();
  });

  it("rejects an SSR GET with 429 at a fully-subscribed cap", async () => {
    const handler = makeHandler({ maxInstancesPerSession: 1 });
    const abort = new AbortController();
    await openStream(handler, "get-cap", "s1", abort.signal);
    await mount(handler, "get-cap", "/org/1/board", "s1");
    const res = await handler.fetch(
      new Request(`${base}/org/9/board`, { headers: cookieOf("get-cap") }),
    );
    expect(res.status).toBe(429);
    expect(handler.instanceCount).toBe(1);
    abort.abort();
    await handler.dispose();
  });

  it("answers a WS mount at the cap with an error envelope instead of hanging", async () => {
    const handler = makeHandler({ maxInstancesPerSession: 1 });
    const sent: Envelope[] = [];
    const sock = handler.socket("ws-cap", {}, (env) => sent.push(env));
    await sock.message(JSON.stringify({ type: "mount", path: "/org/1/board" }));
    expect(handler.instanceCount).toBe(1);
    await sock.message(JSON.stringify({ type: "mount", path: "/org/2/board" }));
    expect(sent.find((e) => e.error)?.error?.name).toBe("SessionCapError");
    expect(handler.instanceCount).toBe(1);
    // Warm re-mount of the held path still succeeds at the cap (no error).
    const before = sent.length;
    await sock.message(JSON.stringify({ type: "mount", path: "/org/1/board" }));
    expect(sent.slice(before).find((e) => e.error)).toBeUndefined();
    sock.close();
    await handler.dispose();
  });
});

describe("duplicate concurrent mounts — one key, one entry", () => {
  it("dedupes twin mounts for the same sid:path and disposes the loser", async () => {
    let reactions = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    interface DupState {
      n: number;
    }
    const dupDef: LiveDefinition<DupState, "/dup", Record<string, unknown>> = {
      setup: (ctx) => {
        ctx.subscribe("dup-topic");
        return { n: 0 };
      },
      load: async () => {
        await gate; // parks both mounts past the warm-reuse check
      },
      on: {
        ping: (state) => {
          reactions++;
          state.n++;
        },
      },
    };
    const storage = memory();
    const handler = createRpxdHandler({
      routes: [{ path: "/dup", def: dupDef }],
      storage,
      warmTtlMs: 1000,
      attachTtlMs: 100,
      cookie: { sign: false }, // fixed literal cookie below needs a stable, unsigned sid
    });
    const req = () =>
      new Request(`${base}/__rpxd/control`, {
        method: "POST",
        headers: cookieOf("dup"),
        body: JSON.stringify({ type: "mount", path: "/dup" }),
      });
    const p1 = handler.fetch(req());
    const p2 = handler.fetch(req());
    await new Promise((r) => setTimeout(r, 20)); // both in-flight, parked in load
    release();
    const [r1, r2] = await Promise.all([p1, p2]);
    const id1 = ((await r1.json()) as { instance: string }).instance;
    const id2 = ((await r2.json()) as { instance: string }).instance;
    expect(id2).toBe(id1); // the loser adopted the winner
    expect(handler.instanceCount).toBe(1);
    // The loser is disposed — its pubsub subscription must not react.
    storage.bus.publish({
      topic: "dup-topic",
      event: "ping",
      payload: {},
      senderId: "other",
      self: false,
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(reactions).toBe(1);
    // Attach the winner, then let any orphan's eviction timer fire: the
    // winner's registry slot and snapshot row must survive it.
    const abort = new AbortController();
    await handler.fetch(
      new Request(`${base}/__rpxd/stream`, { headers: cookieOf("dup"), signal: abort.signal }),
    );
    await new Promise((r) => setTimeout(r, 150)); // past attachTtlMs(100) — an orphan would have evicted
    expect(handler.sessionCount).toBe(1); // slot not clobbered by a twin's eviction
    expect(await storage.get("dup:/dup")).toBeDefined(); // snapshot row not clobbered
    abort.abort();
    await handler.dispose();
  });
});

describe("stream cleanup — re-arm from the live registry, not a stale capture", () => {
  it("evicts a post-prune mount after its stream disconnects", async () => {
    const handler = makeHandler({ warmTtlMs: 15, attachTtlMs: 5 });
    const abort = new AbortController();
    await openStream(handler, "prune", "s1", abort.signal);
    const a = (await (await mount(handler, "prune", "/org/1/board", "s1")).json())
      .instance as string;
    // Release A → idle → evicted → the empty session slice is pruned, orphaning
    // the map the stream captured at connect time.
    await handler.fetch(
      new Request(`${base}/__rpxd/control`, {
        method: "POST",
        headers: cookieOf("prune"),
        body: JSON.stringify({ type: "release", instance: a, stream: "s1" }),
      }),
    );
    await new Promise((r) => setTimeout(r, 60));
    expect(handler.instanceCount).toBe(0);
    expect(handler.sessionCount).toBe(0); // slice pruned — the capture is now stale
    // B lands in a fresh slice and joins the same live stream.
    await mount(handler, "prune", "/org/2/board", "s1");
    expect(handler.instanceCount).toBe(1);
    abort.abort(); // disconnect: cleanup must re-arm B's eviction timer
    await new Promise((r) => setTimeout(r, 80));
    expect(handler.instanceCount).toBe(0); // B evicted, not leaked
    await handler.dispose();
  });
});

describe("WS mount — guard redirects answer on the socket (§10)", () => {
  it("sends a redirect envelope when a WS mount is denied by guard", async () => {
    const guardedDef: LiveDefinition<{ ok: boolean }, "/guarded", Record<string, unknown>> = {
      setup: () => ({ ok: true }),
      guard: () => {
        throw redirect("/login");
      },
    };
    const handler = createRpxdHandler({ routes: [{ path: "/guarded", def: guardedDef }] });
    const sent: Envelope[] = [];
    const sock = handler.socket("ws-redir", {}, (env) => sent.push(env));
    await sock.message(JSON.stringify({ type: "mount", path: "/guarded" }));
    expect(sent.find((e) => e.redirect)?.redirect).toBe("/login");
    expect(handler.instanceCount).toBe(0); // guard-first: nothing built
    sock.close();
    await handler.dispose();
  });

  it("echoes the mount frame's mountId on the redirect envelope (#65 correlation)", async () => {
    // A denied mount has no bound instance to address the redirect to
    // (`instance: ""`), so the client can only correlate it via the mountId it
    // sent on the frame.
    const guardedDef: LiveDefinition<{ ok: boolean }, "/guarded", Record<string, unknown>> = {
      setup: () => ({ ok: true }),
      guard: () => {
        throw redirect("/login");
      },
    };
    const handler = createRpxdHandler({ routes: [{ path: "/guarded", def: guardedDef }] });
    const sent: Envelope[] = [];
    const sock = handler.socket("ws-redir-id", {}, (env) => sent.push(env));
    await sock.message(JSON.stringify({ type: "mount", path: "/guarded", mountId: "m7" }));
    const env = sent.find((e) => e.redirect);
    expect(env?.redirect).toBe("/login");
    expect(env?.instance).toBe(""); // no warm entry — nothing to bind to
    expect(env?.mountId).toBe("m7");
    sock.close();
    await handler.dispose();
  });

  it("echoes mountId on cap and not-found error envelopes too (#65)", async () => {
    const handler = makeHandler({ maxInstancesPerSession: 1 });
    const sent: Envelope[] = [];
    const sock = handler.socket("ws-err-id", {}, (env) => sent.push(env));
    // Not-found first — once the cap is full, the (earlier) cap check would
    // reject an unmatched path as SessionCapError before the route lookup.
    await sock.message(JSON.stringify({ type: "mount", path: "/nowhere", mountId: "m-404" }));
    const notFound = sent.find((e) => e.error?.name === "NotFoundError");
    expect(notFound?.mountId).toBe("m-404");
    await sock.message(JSON.stringify({ type: "mount", path: "/org/1/board" }));
    await sock.message(JSON.stringify({ type: "mount", path: "/org/2/board", mountId: "m-cap" }));
    const cap = sent.find((e) => e.error?.name === "SessionCapError");
    expect(cap?.mountId).toBe("m-cap");
    sock.close();
    await handler.dispose();
  });
});
