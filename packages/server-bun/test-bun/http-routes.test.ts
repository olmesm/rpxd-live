/**
 * HTTP routes (`route()`, docs/routes-and-auth.md) dispatched by the handler
 * before the SSR/404 block — method matching, catch-all, session/sid in ctx,
 * and fall-through to live pages for unmatched paths.
 */
import { describe, expect, it } from "bun:test";
import { type LiveDefinition, route } from "@rpxd/core";
import { createRpxdHandler } from "../src/handler.ts";

const liveDef: LiveDefinition<{ n: number }, "/", Record<string, unknown>> = {
  mount: async () => ({ n: 1 }),
};

const webhook = route("/api/webhooks/stripe").post(
  (_req, ctx) =>
    new Response(JSON.stringify({ params: ctx.params, sid: ctx.sid, session: ctx.session }), {
      headers: { "content-type": "application/json" },
    }),
);

const auth = route("/api/auth/$").all(
  (req, ctx) => new Response(`auth:${ctx.params.$}:${req.method}`),
);

function make() {
  return createRpxdHandler({
    routes: [{ path: "/", def: liveDef }],
    httpRoutes: [webhook, auth],
    authenticate: (_req, { sid }) => ({ sid, who: "alice" }),
    warmTtlMs: 10,
  });
}

describe("HTTP route dispatch", () => {
  it("dispatches a matched method with params, session and sid in ctx", async () => {
    const h = make();
    const res = await h.fetch(new Request("http://x/api/webhooks/stripe", { method: "POST" }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { params: unknown; sid: string; session: { who: string } };
    expect(body.session.who).toBe("alice");
    expect(typeof body.sid).toBe("string");
    expect(res.headers.get("set-cookie")).toContain("rpxd_sid=");
    await h.dispose();
  });

  it("405s when the method has no handler", async () => {
    const h = make();
    const res = await h.fetch(new Request("http://x/api/webhooks/stripe", { method: "GET" }));
    expect(res.status).toBe(405);
    await h.dispose();
  });

  it("all() catch-all handles any method and captures the rest", async () => {
    const h = make();
    const post = await h.fetch(new Request("http://x/api/auth/sign-in/email", { method: "POST" }));
    expect(await post.text()).toBe("auth:sign-in/email:POST");
    const get = await h.fetch(new Request("http://x/api/auth/session", { method: "GET" }));
    expect(await get.text()).toBe("auth:session:GET");
    await h.dispose();
  });

  it("falls through to live pages for unmatched HTTP paths", async () => {
    const h = make();
    const res = await h.fetch(new Request("http://x/"));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('"state":{"n":1}'); // SSR of the live page
    await h.dispose();
  });

  it("404s an unknown path that matches neither http nor live routes", async () => {
    const h = make();
    const res = await h.fetch(new Request("http://x/nope"));
    expect(res.status).toBe(404);
    await h.dispose();
  });
});
