/**
 * The warm per-session instance (§12) is reused only while the authenticated
 * session is unchanged. When `authenticate` returns a different session
 * (login/logout, §10), the instance is re-mounted so `mount`'s
 * session-scoped state reflects the new principal — otherwise a reload would
 * render the old user.
 */
import { describe, expect, it } from "bun:test";
import type { LiveDefinition } from "@rpxd/core";
import { createRpxdHandler } from "../src/handler.ts";

describe("session-change re-mount", () => {
  it("reuses the warm instance for the same session, re-mounts on change", async () => {
    let mounts = 0;
    const def: LiveDefinition<{ who: string }, "/", { sid: string; user?: string }> = {
      mount: async (_p, ctx) => {
        mounts++;
        return { who: ctx.session.user ?? "anon" };
      },
    };
    const handler = createRpxdHandler({
      routes: [{ path: "/", def }],
      authenticate: (req, { sid }) => ({ sid, user: req.headers.get("x-user") ?? undefined }),
      warmTtlMs: 10_000,
    });
    const cookie = "rpxd_sid=fixed-sid"; // pin the session so all hit one instance key
    const get = (user?: string) =>
      handler.fetch(
        new Request("http://x/", { headers: user ? { cookie, "x-user": user } : { cookie } }),
      );

    expect(await (await get("alice")).text()).toContain('"who":"alice"');
    // same session again → warm instance reused, mount not re-run
    expect(await (await get("alice")).text()).toContain('"who":"alice"');
    expect(mounts).toBe(1);

    // different user → re-mount with the new principal
    expect(await (await get("bob")).text()).toContain('"who":"bob"');
    expect(mounts).toBe(2);

    // sign-out (no user) → re-mount as anonymous
    expect(await (await get()).text()).toContain('"who":"anon"');
    expect(mounts).toBe(3);

    await handler.dispose();
  });
});
