/**
 * The warm instance is reused only while the authenticated session is
 * unchanged. When `authenticate` returns a different session (login/logout,
 * §10), the instance is re-mounted so `setup`'s session-scoped state reflects
 * the new principal — otherwise the stale principal would keep rendering.
 *
 * Warm reuse is a SAME-STREAM property under ADR 0003 (instances are
 * stream-scoped): the reuse path here is a tab re-mounting its own identity
 * over the control plane. Page GETs always build fresh (each reload is a new
 * instance, Phoenix-style), so the GET path can no longer serve a stale
 * principal by construction.
 */
import { describe, expect, it } from "bun:test";
import type { LiveDefinition } from "@rpxd/core";
import { createRpxdHandler } from "../src/handler.ts";

describe("session-change re-mount", () => {
  it("reuses the warm instance for the same session, re-mounts on change", async () => {
    let mounts = 0;
    const def: LiveDefinition<{ who: string }, "/", { sid: string; user?: string }> = {
      setup: (ctx) => {
        mounts++;
        return { who: ctx.session.user ?? "anon" };
      },
    };
    const handler = createRpxdHandler({
      routes: [{ path: "/", def }],
      authenticate: (req, { sid }) => ({ sid, user: req.headers.get("x-user") ?? undefined }),
      warmTtlMs: 10_000,
      cookie: { sign: false }, // fixed literal cookie below needs a stable, unsigned sid
    });
    const cookie = "rpxd_sid=fixed-sid"; // pin the session so all hit one instance key
    const mount = async (user?: string) => {
      const res = await handler.fetch(
        new Request("http://x/__rpxd/control", {
          method: "POST",
          headers: user ? { cookie, "x-user": user } : { cookie },
          body: JSON.stringify({ type: "mount", path: "/", stream: "s1" }),
        }),
      );
      return ((await res.json()) as { instance: string }).instance;
    };

    const first = await mount("alice");
    // same stream + same session again → warm instance reused, setup not re-run
    expect(await mount("alice")).toBe(first);
    expect(mounts).toBe(1);

    // different user → re-mount with the new principal
    expect(await mount("bob")).not.toBe(first);
    expect(mounts).toBe(2);

    // sign-out (no user) → re-mount as anonymous
    await mount();
    expect(mounts).toBe(3);

    await handler.dispose();
  });
});
