/**
 * `redirect()` from `setup`/`guard` (§10, the routes & auth guide): a full page
 * load gets a real 302; a client control-mount / runtime URL change (SPA nav)
 * gets a `{ redirect }` JSON signal the router acts on (a 302 would be
 * auto-followed by fetch). `setup` is a coarse fail-fast; `guard` is auth's home
 * and re-checks on every URL change.
 */
import { describe, expect, it } from "bun:test";
import { type LiveDefinition, redirect } from "@rpxd/core";
import { createRpxdHandler } from "../src/handler.ts";

const setupGated: LiveDefinition<Record<string, unknown>, "/gated", { user?: string }> = {
  setup: (ctx) => {
    if (!ctx.session.user) throw redirect("/login");
    return { ok: true };
  },
};

// Auth in `guard` — runs on every URL change (path + search), so a spoofed
// `?admin=` is re-checked even without a remount.
const guardGated: LiveDefinition<{ ok: boolean }, "/g", { user?: string }> = {
  setup: () => ({ ok: true }),
  guard: async ({ search }, ctx) => {
    if (!ctx.session.user) throw redirect("/login");
    if (search.admin && ctx.session.user !== "root") throw redirect("/403");
  },
  load: async () => {},
};

const make = (def: LiveDefinition<never, never, never>, path: string) =>
  createRpxdHandler({
    routes: [{ path, def: def as never }],
    authenticate: (req, { sid }) => ({ sid, user: req.headers.get("x-user") ?? undefined }),
    warmTtlMs: 10,
    cookie: { sign: false }, // fixed literal cookies below need a stable, unsigned sid
  });

describe("redirect() from setup", () => {
  it("GET → 302 to the target when setup redirects", async () => {
    const h = make(setupGated as never, "/gated");
    const res = await h.fetch(new Request("http://x/gated"));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/login");
    await h.dispose();
  });

  it("GET → 200 renders when setup does not redirect", async () => {
    const h = make(setupGated as never, "/gated");
    const res = await h.fetch(new Request("http://x/gated", { headers: { "x-user": "alice" } }));
    expect(res.status).toBe(200);
    await h.dispose();
  });

  it("control mount → { redirect } JSON for SPA navigation", async () => {
    const h = make(setupGated as never, "/gated");
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

describe("redirect() from guard (§10)", () => {
  it("GET → 302 when the guard denies before serving", async () => {
    const h = make(guardGated as never, "/g");
    const res = await h.fetch(new Request("http://x/g"));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/login");
    await h.dispose();
  });

  it("GET → 200 when the guard passes", async () => {
    const h = make(guardGated as never, "/g");
    const res = await h.fetch(new Request("http://x/g", { headers: { "x-user": "alice" } }));
    expect(res.status).toBe(200);
    await h.dispose();
  });

  it("runtime URL change (nav.patch) that the guard denies → { redirect } JSON", async () => {
    const h = make(guardGated as never, "/g");
    const cookie = "rpxd_sid=s1";
    // Mount authorized (no admin), then patch to ?admin=1 as a non-root user.
    const mountRes = await h.fetch(
      new Request("http://x/__rpxd/control", {
        method: "POST",
        headers: { "content-type": "application/json", cookie, "x-user": "alice" },
        body: JSON.stringify({ type: "mount", path: "/g" }),
      }),
    );
    const { instance } = await mountRes.json();
    const patchRes = await h.fetch(
      new Request("http://x/__rpxd/control", {
        method: "POST",
        headers: { "content-type": "application/json", cookie, "x-user": "alice" },
        body: JSON.stringify({ type: "url", instance, search: { admin: "1" } }),
      }),
    );
    expect(await patchRes.json()).toEqual({ redirect: "/403" });
    await h.dispose();
  });
});
