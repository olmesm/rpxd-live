/**
 * `redirect()` from `mount` (§10, the routes & auth guide): a full page load
 * gets a real 302; a client control-mount (SPA nav) gets a `{ redirect }`
 * JSON signal the router acts on (a 302 would be auto-followed by fetch).
 */
import { describe, expect, it } from "bun:test";
import { type LiveDefinition, redirect } from "@rpxd/core";
import { createRpxdHandler } from "../src/handler.ts";

const gated: LiveDefinition<Record<string, unknown>, "/gated", { user?: string }> = {
  mount: async (_p, ctx) => {
    if (!ctx.session.user) throw redirect("/login");
    return { ok: true };
  },
};

const make = () =>
  createRpxdHandler({
    routes: [{ path: "/gated", def: gated }],
    authenticate: (req, { sid }) => ({ sid, user: req.headers.get("x-user") ?? undefined }),
    warmTtlMs: 10,
  });

describe("redirect() from mount", () => {
  it("GET → 302 to the target when mount redirects", async () => {
    const h = make();
    const res = await h.fetch(new Request("http://x/gated"));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/login");
    await h.dispose();
  });

  it("GET → 200 renders when mount does not redirect", async () => {
    const h = make();
    const res = await h.fetch(new Request("http://x/gated", { headers: { "x-user": "alice" } }));
    expect(res.status).toBe(200);
    await h.dispose();
  });

  it("control mount → { redirect } JSON for SPA navigation", async () => {
    const h = make();
    const res = await h.fetch(
      new Request("http://x/__rpxd/control", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "mount", path: "/gated" }),
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ redirect: "/login" });
    await h.dispose();
  });
});
