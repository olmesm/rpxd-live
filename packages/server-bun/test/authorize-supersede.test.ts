import { type LiveDefinition, redirect } from "@rpxd/core";
import { describe, expect, it } from "vitest";
import { createRpxdHandler } from "../src/handler.ts";

interface UserState {
  rows: string[];
  who?: string;
}

const COOKIE = { cookie: "rpxd_sid=race-a" };

const control = (
  handler: ReturnType<typeof createRpxdHandler>,
  body: Record<string, unknown>,
): Promise<Response> =>
  handler.fetch(
    new Request("http://localhost/__rpxd/control", {
      method: "POST",
      headers: COOKIE,
      body: JSON.stringify(body),
    }),
  );

const tick = (ms = 0) => new Promise<void>((r) => setTimeout(r, ms));

// Two racing `url` reconciles on one instance (§10): request A carries a URL
// the guard denies (slowly), request B an allowed one. B supersedes A's guard;
// A's deny must bail quietly — never fall through to load the denied URL.
describe("racing URL reconciles with a slow guard deny (§10)", () => {
  it("a superseded deny never loads the denied URL's data and never 500s", async () => {
    let releaseDeny: () => void = () => {};
    const loaded: string[] = [];
    const def: LiveDefinition<UserState, "/u", Record<string, unknown>> = {
      setup: () => ({ rows: [] }),
      guard: async ({ search }) => {
        if (search.userId && search.userId !== "me") {
          await new Promise<void>((r) => {
            releaseDeny = r;
          });
          throw redirect("/403"); // slow deny — superseded mid-flight
        }
      },
      load: async ({ search }, ctx) => {
        const key = search.userId ?? search.q ?? "none";
        loaded.push(key);
        ctx.patchState((s) => {
          s.who = key;
          s.rows = [`rows-for-${key}`];
        });
      },
    };
    const handler = createRpxdHandler({ routes: [{ path: "/u", def }] });

    const mountRes = await control(handler, { type: "mount", path: "/u", search: {} });
    const { instance } = (await mountRes.json()) as { instance: string };

    // Request A: the denied URL — its guard parks mid-deny.
    const denied = control(handler, { type: "url", instance, search: { userId: "other" } });
    await tick(); // A's guard is now awaiting inside the deny branch
    // Request B: an allowed URL — supersedes A's guard run.
    const allowed = await control(handler, { type: "url", instance, search: { q: "x" } });
    expect(allowed.status).toBe(204);

    releaseDeny(); // A's guard now throws its deny — into a superseded run
    const deniedRes = await denied;
    // The superseded run bails quietly: no 500, no redirect payload...
    expect(deniedRes.status).toBe(204);
    await tick(10);
    // ...and crucially no load: the denied URL's data never entered the
    // instance (state is written only by the loader).
    expect(loaded).not.toContain("other");
    expect(loaded).toContain("x");

    await handler.dispose();
  });
});
