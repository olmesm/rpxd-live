import type { LiveDefinition } from "@rpxd/core";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createRpxdHandler, type RouteRegistration } from "../src/handler.ts";

const base = "http://localhost";
const COOKIE = { cookie: "rpxd_sid=session-a" };

/** Pull the SSR bootstrap `{ snapshot, ... }` out of a rendered document. */
async function bootstrapOf(res: Response): Promise<Record<string, unknown>> {
  const html = await res.text();
  const json = /<script id="__rpxd" type="application\/json">(.*?)<\/script>/s.exec(html)?.[1];
  return JSON.parse(json as string);
}

interface TypedState {
  limit: number | null;
  seen: unknown;
}

// Records what `guard`/`load` observed, so a rejected GET can be proven to have
// never reached userland with invalid props.
let observed: { guard: unknown[]; load: unknown[] };

const limitSchema = z.object({ limit: z.number() });

const typedDef: LiveDefinition<TypedState, "/typed", Record<string, unknown>, { limit: number }> = {
  setup: () => ({ limit: null, seen: null }),
  guard: ({ props }) => {
    observed.guard.push(props);
  },
  load: async ({ props }, ctx) => {
    observed.load.push(props);
    ctx.patchState((s) => {
      s.limit = props.limit;
      s.seen = props;
    });
  },
};

interface FeedState {
  filter: string;
}

// Schema-less route — must keep raw-string props (back-compat), no decode.
const feedDef: LiveDefinition<FeedState, "/feed", Record<string, unknown>> = {
  setup: () => ({ filter: "" }),
  load: async ({ props }, ctx) => {
    ctx.patchState((s) => {
      s.filter = (props.filter as string) ?? "";
    });
  },
};

function makeHandler(routes: RouteRegistration[]) {
  observed = { guard: [], load: [] };
  return createRpxdHandler({ routes, cookie: { sign: false } });
}

describe("props codec — page GET integration", () => {
  it("decodes + validates typed props: `?limit=20` reaches load as the number 20", async () => {
    const handler = makeHandler([{ path: "/typed", def: typedDef, props: limitSchema }]);
    const res = await handler.fetch(new Request(`${base}/typed?limit=20`, { headers: COOKIE }));
    expect(res.status).toBe(200);
    const boot = await bootstrapOf(res);
    expect((boot.snapshot as { state: TypedState }).state.limit).toBe(20);
    // The value handed to guard/load is a number, not the raw string "20".
    expect(observed.load[0]).toEqual({ limit: 20 });
    expect(observed.guard[0]).toEqual({ limit: 20 });
  });

  it("rejects invalid typed props with 422; guard/load never run", async () => {
    const handler = makeHandler([{ path: "/typed", def: typedDef, props: limitSchema }]);
    const res = await handler.fetch(new Request(`${base}/typed?limit=abc`, { headers: COOKIE }));
    expect(res.status).toBe(422);
    expect(observed.guard).toEqual([]);
    expect(observed.load).toEqual([]);
  });

  it("validation runs before guard on a warm reconcile too (second GET, same session)", async () => {
    const handler = makeHandler([{ path: "/typed", def: typedDef, props: limitSchema }]);
    // Warm the instance.
    await handler.fetch(new Request(`${base}/typed?limit=20`, { headers: COOKIE }));
    // A second GET carrying invalid props must still 422 without re-running load.
    observed = { guard: [], load: [] };
    const res = await handler.fetch(new Request(`${base}/typed?limit=nope`, { headers: COOKIE }));
    expect(res.status).toBe(422);
    expect(observed.load).toEqual([]);
  });

  it('schema-less route keeps the raw string props (`?filter=done` stays "done")', async () => {
    const handler = makeHandler([{ path: "/feed", def: feedDef }]);
    const res = await handler.fetch(new Request(`${base}/feed?filter=done`, { headers: COOKIE }));
    expect(res.status).toBe(200);
    const boot = await bootstrapOf(res);
    expect((boot.snapshot as { state: FeedState }).state.filter).toBe("done");
  });
});
