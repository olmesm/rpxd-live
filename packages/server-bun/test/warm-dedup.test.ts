/**
 * Warm-mount dedup — re-guard ALWAYS, re-load only on change (ADR 0002 item 8).
 *
 * Warm reuse previously reran `guard`+`load` unconditionally, so a second tab
 * on a slot-bearing page re-executed every slot's `load` (the multi-tab storm).
 * The new rule, applied wherever a LIVE in-memory instance reconciles — the
 * warm-reuse branch of `mountInstance` and the `url` control message (HTTP + WS),
 * all funnelled through `reconcileEntry`: **always** rerun `guard` (authorization
 * freshness, §10), but SKIP `load` when the incoming props canonicalize
 * (`canonicalProps`) to the entry's last winning reconcile AND the instance is
 * live (a snapshot-restored cold wake still reloads fully — §9). These pin:
 * identical-props warm mount → guard +1 / load +0; changed props → both, with
 * the new validated props; identical-props `url` patch → guard +1 / load +0; a
 * cold-woken instance reloads even on identical props (the §9 override); a guard
 * deny on the skipped-load path still redirects; a load that throws (or is
 * superseded) never advances the dedup key, so the next attempt reloads.
 */
import { type LiveDefinition, memory, redirect } from "@rpxd/core";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createRpxdHandler } from "../src/handler.ts";

const base = "http://test.local";
const COOKIE = { cookie: "rpxd_sid=session-a" };

// A schema'd page route with guard + load spies and per-test toggles: `denyTo`
// makes guard throw a redirect; `loadRedirect` makes load throw one; a
// `limit: 1` load parks (via `releaseSlowLoad`) so a later patch supersedes it.
interface DashState {
  limit: number | null;
  loadCount: number;
}
const dashSchema = z.object({ limit: z.number() });
let guardSpy: unknown[];
let loadSpy: unknown[];
let denyTo: string | null;
let loadRedirect: string | null;
let releaseSlowLoad: (() => void) | null;

const dashDef: LiveDefinition<DashState, "/dash", Record<string, unknown>, { limit: number }> = {
  setup: () => ({ limit: null, loadCount: 0 }),
  guard: ({ props }) => {
    guardSpy.push(props);
    if (denyTo) throw redirect(denyTo);
  },
  load: async ({ props }, ctx) => {
    loadSpy.push(props);
    if (loadRedirect) throw redirect(loadRedirect); // before any patch → propagates
    if (props.limit === 1) {
      await new Promise<void>((r) => {
        releaseSlowLoad = r;
      });
    }
    ctx.patchState((s) => {
      s.limit = props.limit as number;
      s.loadCount += 1;
    });
  },
};

const tick = (ms = 0) => new Promise<void>((r) => setTimeout(r, ms));

function reset(): void {
  guardSpy = [];
  loadSpy = [];
  denyTo = null;
  loadRedirect = null;
  releaseSlowLoad = null;
}

function makeHandler(overrides: Record<string, unknown> = {}) {
  reset();
  return createRpxdHandler({
    routes: [{ path: "/dash", def: dashDef, props: dashSchema }],
    warmTtlMs: 1000,
    attachTtlMs: 1000,
    cookie: { sign: false },
    ...overrides,
  });
}

type Handler = ReturnType<typeof makeHandler>;

/** POST a control message (no stream) and return the parsed JSON body. */
async function control(handler: Handler, body: unknown): Promise<Response> {
  return handler.fetch(
    new Request(`${base}/__rpxd/control`, {
      method: "POST",
      headers: COOKIE,
      body: JSON.stringify(body),
    }),
  );
}

async function mount(handler: Handler, props: Record<string, unknown>): Promise<string> {
  const res = await control(handler, { type: "mount", path: "/dash", props });
  const { instance } = (await res.json()) as { instance: string };
  return instance;
}

describe("warm-mount dedup: re-guard always, re-load on change (ADR 0002 item 8)", () => {
  it("warm mount, IDENTICAL props → guard +1, load +0 (the multi-tab storm)", async () => {
    const handler = makeHandler();
    await mount(handler, { limit: 10 }); // fresh build: guard 1, load 1
    expect(guardSpy).toHaveLength(1);
    expect(loadSpy).toHaveLength(1);

    // Second tab, same key + session + props → warm reuse. Re-guard, skip load.
    await mount(handler, { limit: 10 });
    expect(guardSpy).toHaveLength(2); // re-guarded (authorization freshness)
    expect(loadSpy).toHaveLength(1); // load SKIPPED — props unchanged
    await handler.dispose();
  });

  it("warm mount, CHANGED props → guard +1, load +1 with the new validated props", async () => {
    const handler = makeHandler();
    await mount(handler, { limit: 10 });
    expect(loadSpy).toHaveLength(1);

    await mount(handler, { limit: 20 });
    expect(guardSpy).toHaveLength(2);
    expect(loadSpy).toHaveLength(2); // reloaded — props changed
    expect(loadSpy[1]).toEqual({ limit: 20 }); // the new VALIDATED (number) props
    await handler.dispose();
  });

  it("url patch, IDENTICAL props → guard +1, load +0", async () => {
    const handler = makeHandler();
    const instance = await mount(handler, { limit: 10 });
    expect(guardSpy).toHaveLength(1);
    expect(loadSpy).toHaveLength(1);

    const res = await control(handler, { type: "url", instance, props: { limit: 10 } });
    expect(res.status).toBe(204);
    await tick(10);
    expect(guardSpy).toHaveLength(2); // guard STILL runs on identical props
    expect(loadSpy).toHaveLength(1); // load SKIPPED
    await handler.dispose();
  });

  it("cold wake: a snapshot-restored instance reloads even on identical props (§9)", async () => {
    // Share storage so the snapshot survives eviction; short warm TTL so the
    // abort evicts the ATTACHED first instance promptly (`everAttached` makes
    // that eviction persist). A generous `unattachedTtlMs` keeps the later
    // cold-remounted (stream-less) instance alive long enough to receive the
    // follow-up `url` patch (else it evicts and the patch 404s).
    const storage = memory();
    const handler = makeHandler({
      storage,
      warmTtlMs: 20,
      attachTtlMs: 10,
      unattachedTtlMs: 1000,
    });

    const ac = new AbortController();
    const streamRes = await handler.fetch(
      new Request(`${base}/__rpxd/stream?stream=s1`, { headers: COOKIE, signal: ac.signal }),
    );
    void (streamRes.body as ReadableStream).getReader().read(); // open the stream
    await control(handler, { type: "mount", path: "/dash", props: { limit: 10 }, stream: "s1" });
    await tick(10);
    expect(loadSpy).toHaveLength(1); // fresh build loaded once

    // Abort the stream → release → evict + persist the snapshot.
    ac.abort();
    await tick(80);
    expect(handler.instanceCount).toBe(0);

    // Cold re-mount with IDENTICAL props → restore snapshot → load RUNS (a fresh
    // build always loads), and the restored instance's `lastProps` is seeded.
    const instance = await mount(handler, { limit: 10 });
    await tick(10);
    expect(loadSpy).toHaveLength(2); // cold wake reloaded despite identical props

    // The §9 override is load-bearing: an immediate identical `url` patch on the
    // restored instance STILL reloads (the dedup key matches, but the instance
    // was cold-woken so it never skips) — this is what the readonly
    // `restoredFromSnapshot` flag guards; without it this patch would skip.
    await control(handler, { type: "url", instance, props: { limit: 10 } });
    await tick(10);
    expect(loadSpy).toHaveLength(3);
    await handler.dispose();
  });

  it("guard deny on the skipped-load path still propagates (redirect)", async () => {
    const handler = makeHandler();
    const instance = await mount(handler, { limit: 10 });
    expect(loadSpy).toHaveLength(1);

    // Identical props (load would skip) — but guard now denies.
    denyTo = "/login";
    const res = await control(handler, { type: "url", instance, props: { limit: 10 } });
    expect(await res.json()).toEqual({ redirect: "/login" });
    expect(guardSpy).toHaveLength(2); // guard ran on the skip path
    expect(loadSpy).toHaveLength(1); // load never ran (guard denied first)
    await handler.dispose();
  });

  it("a load that throws does NOT advance lastProps → the next identical reconcile reloads", async () => {
    const handler = makeHandler();
    const instance = await mount(handler, { limit: 10 }); // lastProps ← {limit:10}
    expect(loadSpy).toHaveLength(1);

    // Changed props, but the load throws a redirect (propagates) — a failed
    // reconcile must not become the new dedup baseline.
    loadRedirect = "/boom";
    const denied = await control(handler, { type: "url", instance, props: { limit: 20 } });
    expect(await denied.json()).toEqual({ redirect: "/boom" });
    expect(loadSpy).toHaveLength(2); // load ran (and threw)

    // Same {limit:20} again, now succeeding: because the throw never advanced
    // lastProps (still {limit:10}), this must RUN load — not skip it.
    loadRedirect = null;
    const res = await control(handler, { type: "url", instance, props: { limit: 20 } });
    expect(res.status).toBe(204);
    await tick(10);
    expect(loadSpy).toHaveLength(3); // reloaded — a thrown load left no baseline
    expect(loadSpy[2]).toEqual({ limit: 20 });
    await handler.dispose();
  });

  it("superseded load: lastProps reflects only the winning run", async () => {
    const handler = makeHandler();
    const instance = await mount(handler, { limit: 10 });
    expect(loadSpy).toHaveLength(1);

    // Patch A (limit: 1) parks inside its loader.
    const a = control(handler, { type: "url", instance, props: { limit: 1 } });
    await tick(); // A is parked
    // Patch B (limit: 2) supersedes A and wins → lastProps ← {limit:2}.
    const b = await control(handler, { type: "url", instance, props: { limit: 2 } });
    expect(b.status).toBe(204);
    releaseSlowLoad?.(); // A resumes — its writes drop, it did NOT win
    expect((await a).status).toBe(204);
    await tick(10);

    const before = loadSpy.length; // [{10},{1},{2}]
    // {limit:2} is the WINNER's props → identical → skip (proves lastProps=={2},
    // not the superseded A's {1}).
    await control(handler, { type: "url", instance, props: { limit: 2 } });
    await tick(10);
    expect(loadSpy).toHaveLength(before); // skipped

    // A different value (3 — doesn't park) reloads, confirming the baseline is
    // the winner's {2}: had A's superseded run wrongly set lastProps to {1}, a
    // {2} patch would already have reloaded above. The reload here is just the
    // positive control that the dedup isn't wedged.
    await control(handler, { type: "url", instance, props: { limit: 3 } });
    await tick(10);
    expect(loadSpy.length).toBeGreaterThan(before);
    await handler.dispose();
  });

  it("regression: a warm GET remount with a CHANGED query still reconciles", async () => {
    const handler = makeHandler();
    // A browser GET mounts + loads the page.
    await handler.fetch(new Request(`${base}/dash?limit=10`, { headers: COOKIE }));
    expect(loadSpy).toHaveLength(1);
    expect(loadSpy[0]).toEqual({ limit: 10 });

    // A second GET to the same path with a CHANGED query → warm reuse reconciles.
    await handler.fetch(new Request(`${base}/dash?limit=42`, { headers: COOKIE }));
    expect(loadSpy).toHaveLength(2);
    expect(loadSpy[1]).toEqual({ limit: 42 }); // decoded to a number, reloaded
    await handler.dispose();
  });
});
