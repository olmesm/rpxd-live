/**
 * Validated tier-1 props patches on the `url` control message (ADR 0002 item 7).
 *
 * The `url` message (HTTP control + WS mirror) validates its props against the
 * instance's registration props schema — via `registrationFor(entry.path)`,
 * which resolves across the mount union so a slot instance finds its own def —
 * **before** `reconcileUrl` (guard→load). These pin: a valid patch reruns `load`
 * with the VALIDATED (typed) props while prior state survives until the loader
 * overwrites it (keepPreviousData); `guard` runs exactly once per patch and
 * still runs on identical props (item 8 changes only the LOAD skip, not guard);
 * an invalid record is a 422 over HTTP (no guard/load) and an instance-scoped
 * error envelope over WS; two rapid patches supersede so only the latest load's
 * writes land; a mount-only slot patches over both transports; and a schema-less
 * `nav.patch` is byte-identical to pre-ADR behavior.
 */
import type { Envelope, LiveDefinition } from "@rpxd/core";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createRpxdHandler } from "../src/handler.ts";

const base = "http://test.local";
const COOKIE = { cookie: "rpxd_sid=session-a" };

// A schema'd page route. Spies capture what guard/load observed so a rejected
// patch can be proven to have never reached userland; `extra` is set in setup
// and never touched by load (the keepPreviousData proof); `releaseSlowLoad`
// parks a `limit: 1` run so a second patch can supersede it.
interface DashState {
  limit: number | null;
  extra: string;
  loadCount: number;
}
const dashSchema = z.object({ limit: z.number() });
let dashGuard: unknown[];
let dashLoad: unknown[];
let releaseSlowLoad: (() => void) | null;
const dashDef: LiveDefinition<DashState, "/dash", Record<string, unknown>, { limit: number }> = {
  setup: () => ({ limit: null, extra: "seed", loadCount: 0 }),
  guard: ({ props }) => {
    dashGuard.push(props);
  },
  load: async ({ props }, ctx) => {
    dashLoad.push(props);
    if (props.limit === 1) {
      // Park the slow first run so a later patch supersedes it (item 7 §3).
      await new Promise<void>((r) => {
        releaseSlowLoad = r;
      });
    }
    ctx.patchState((s) => {
      s.limit = props.limit;
      s.loadCount += 1;
    });
  },
};

// A schema'd mount-only slot — the primary item-7 consumer (items 9–12 client
// work patches slots).
interface PanelState {
  tab: string;
  hits: number;
}
const panelSchema = z.object({ tab: z.string() });
let panelLoad: unknown[];
const panelDef: LiveDefinition<PanelState, "/panel", Record<string, unknown>, { tab: string }> = {
  setup: () => ({ tab: "", hits: 0 }),
  load: async ({ props }, ctx) => {
    panelLoad.push(props);
    ctx.patchState((s) => {
      s.tab = props.tab;
      s.hits += 1;
    });
  },
};

// A schema-less page route — must keep raw-string props (back-compat).
interface FeedState {
  filter: string;
}
const feedDef: LiveDefinition<FeedState, "/feed", Record<string, unknown>> = {
  setup: () => ({ filter: "" }),
  load: async ({ props }, ctx) => {
    ctx.patchState((s) => {
      s.filter = (props.filter as string) ?? "";
    });
  },
};

/** Incremental SSE parser over a streaming Response (mirrors handler.test.ts). */
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
        this.#pendingRead = read;
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

const tick = (ms = 0) => new Promise<void>((r) => setTimeout(r, ms));

function makeHandler() {
  dashGuard = [];
  dashLoad = [];
  panelLoad = [];
  releaseSlowLoad = null;
  return createRpxdHandler({
    routes: [
      { path: "/dash", def: dashDef, props: dashSchema },
      { path: "/feed", def: feedDef },
    ],
    slots: [{ path: "/panel", def: panelDef, props: panelSchema }],
    warmTtlMs: 1000,
    attachTtlMs: 1000,
    cookie: { sign: false },
  });
}

const control = (handler: ReturnType<typeof makeHandler>, body: unknown) =>
  handler.fetch(
    new Request(`${base}/__rpxd/control`, {
      method: "POST",
      headers: COOKIE,
      body: JSON.stringify(body),
    }),
  );

/** Open a stream, mount `path` onto it, return `{ sse, instance }` after the snapshot. */
async function mountOnStream(
  handler: ReturnType<typeof makeHandler>,
  path: string,
  props: Record<string, unknown>,
  streamId = "s1",
): Promise<{ sse: SseReader; instance: string; full: Envelope | null }> {
  const sse = new SseReader(
    await handler.fetch(
      new Request(`${base}/__rpxd/stream?stream=${streamId}`, { headers: COOKIE }),
    ),
  );
  const res = await control(handler, { type: "mount", path, props, stream: streamId });
  const { instance } = (await res.json()) as { instance: string };
  const full = await sse.next();
  return { sse, instance, full };
}

describe("validated props patches on the `url` control message (ADR 0002 item 7)", () => {
  it("valid patch reruns load with VALIDATED (number) props; prior state survives (keepPreviousData)", async () => {
    const handler = makeHandler();
    const { sse, instance, full } = await mountOnStream(handler, "/dash", { limit: 10 });
    expect((full?.full?.state as DashState).limit).toBe(10);

    const patch = await control(handler, { type: "url", instance, props: { limit: 20 } });
    expect(patch.status).toBe(204);

    const env = await sse.next();
    // The loader wrote limit + loadCount; `extra` (setup-only) is never touched —
    // prior state survives the patch until load overwrites its own fields.
    const paths = (env?.patches ?? []).map((p) => p.path.join("."));
    expect(paths).toContain("limit");
    expect(paths).toContain("loadCount");
    expect(paths).not.toContain("extra");

    // load saw the VALIDATED number, not the raw string "20".
    expect(dashLoad[dashLoad.length - 1]).toEqual({ limit: 20 });

    // A resync proves the full post-patch state: limit overwritten, extra intact.
    await control(handler, { type: "resync", instance });
    const resynced = await sse.next();
    expect(resynced?.full?.state).toMatchObject({ limit: 20, extra: "seed", loadCount: 2 });
    await handler.dispose();
  });

  it("guard runs exactly once per patch — and still runs on identical props (item 8 is load-skip only)", async () => {
    const handler = makeHandler();
    const { instance } = await mountOnStream(handler, "/dash", { limit: 10 });
    expect(dashGuard).toHaveLength(1); // the mount's guard

    await control(handler, { type: "url", instance, props: { limit: 20 } });
    expect(dashGuard).toHaveLength(2); // +1

    // Identical props: guard STILL reruns (authorization freshness is never
    // weakened — item 8 changes only the LOAD skip, not guard).
    await control(handler, { type: "url", instance, props: { limit: 20 } });
    expect(dashGuard).toHaveLength(3); // +1 again
    expect(dashGuard[1]).toEqual({ limit: 20 });
    expect(dashGuard[2]).toEqual({ limit: 20 });
    await handler.dispose();
  });

  it("invalid props → 422 over HTTP; guard and load never run", async () => {
    const handler = makeHandler();
    const { instance } = await mountOnStream(handler, "/dash", { limit: 10 });
    const guardBefore = dashGuard.length;
    const loadBefore = dashLoad.length;

    const res = await control(handler, { type: "url", instance, props: { limit: "abc" } });
    expect(res.status).toBe(422);
    // The reconcile never started — no guard, no load past the mount.
    expect(dashGuard).toHaveLength(guardBefore);
    expect(dashLoad).toHaveLength(loadBefore);
    await handler.dispose();
  });

  it("invalid props over WS → instance-scoped error envelope (no mountId); guard and load never run", async () => {
    const handler = makeHandler();
    // Mount over HTTP to own an instance for this sid, then drive the socket.
    const { instance } = await mountOnStream(handler, "/dash", { limit: 10 });
    const guardBefore = dashGuard.length;
    const loadBefore = dashLoad.length;

    const envelopes: Envelope[] = [];
    const sock = handler.socket("session-a", {}, (env) => envelopes.push(env));
    await sock.message(JSON.stringify({ type: "url", instance, props: { limit: "nope" } }));

    const err = envelopes.filter((e) => e.error).pop();
    // The instance IS bound, so the failure is correlated by its id (mirroring
    // the WS `url` redirect surface) — not by a `mountId` like a denied mount.
    expect(err?.instance).toBe(instance);
    expect(err?.error?.name).toBe("ValidationError");
    expect(err?.mountId).toBeUndefined();
    expect(dashGuard).toHaveLength(guardBefore);
    expect(dashLoad).toHaveLength(loadBefore);
    sock.close();
    await handler.dispose();
  });

  it("two rapid patches supersede — only the latest load's writes land (schema'd route)", async () => {
    const handler = makeHandler();
    const { sse, instance } = await mountOnStream(handler, "/dash", { limit: 10 });

    // Patch A (limit: 1) parks in load before it can write.
    const a = control(handler, { type: "url", instance, props: { limit: 1 } });
    await tick(); // A is now parked inside its loader
    // Patch B (limit: 2) supersedes A's run and completes.
    const b = await control(handler, { type: "url", instance, props: { limit: 2 } });
    expect(b.status).toBe(204);

    releaseSlowLoad?.(); // A resumes — its patchState is dropped (superseded run)
    expect((await a).status).toBe(204);
    await tick(10);

    // Both loads ran (validated numbers), but only B's write survives.
    expect(dashLoad).toContainEqual({ limit: 1 });
    expect(dashLoad).toContainEqual({ limit: 2 });
    await control(handler, { type: "resync", instance });
    let env = await sse.next();
    while (env && !env.full) env = await sse.next();
    expect((env?.full?.state as DashState).limit).toBe(2);
    await handler.dispose();
  });

  it("mount-only slot: a props patch reconciles over HTTP", async () => {
    const handler = makeHandler();
    const { sse, instance, full } = await mountOnStream(handler, "/panel", { tab: "a" });
    expect((full?.full?.state as PanelState).tab).toBe("a");

    const patch = await control(handler, { type: "url", instance, props: { tab: "b" } });
    expect(patch.status).toBe(204);
    const env = await sse.next();
    const paths = (env?.patches ?? []).map((p) => p.path.join("."));
    expect(paths).toContain("tab");
    expect(panelLoad[panelLoad.length - 1]).toEqual({ tab: "b" });
    await handler.dispose();
  });

  it("mount-only slot: a props patch reconciles over WS", async () => {
    const handler = makeHandler();
    const envelopes: Envelope[] = [];
    const sock = handler.socket("session-a", {}, (env) => envelopes.push(env));
    // Mount the slot over the socket, then patch it over the socket.
    await sock.message(
      JSON.stringify({ type: "mount", path: "/panel", props: { tab: "a" }, mountId: "m1" }),
    );
    const full = envelopes.find((e) => e.full);
    const instance = full?.instance as string;
    expect((full?.full?.state as PanelState).tab).toBe("a");

    await sock.message(JSON.stringify({ type: "url", instance, props: { tab: "c" } }));
    const patch = envelopes.filter((e) => e.patches).pop();
    const paths = (patch?.patches ?? []).map((p) => p.path.join("."));
    expect(paths).toContain("tab");
    expect(panelLoad[panelLoad.length - 1]).toEqual({ tab: "c" });
    sock.close();
    await handler.dispose();
  });

  it("regression: a schema-less `nav.patch` keeps raw-string props and still reconciles", async () => {
    const handler = makeHandler();
    const { sse, instance } = await mountOnStream(handler, "/feed", { filter: "all" });

    const patch = await control(handler, { type: "url", instance, props: { filter: "done" } });
    expect(patch.status).toBe(204);
    const env = await sse.next();
    // The loader writes page state (§7): a replace on ["filter"] to the raw string.
    expect(env?.patches?.[0]?.op).toBe("replace");
    expect(env?.patches?.[0]?.path).toEqual(["filter"]);
    expect(env?.patches?.[0]?.value).toBe("done");
    await handler.dispose();
  });
});
