/**
 * The pure part of the domain layer — `scopeFrom` — tests without rpxd, a DB,
 * or a browser: it turns `ctx.session` into the `{ sid, user? }` the queries
 * scope by. The Prisma-backed queries and user-scoped isolation are covered
 * end-to-end by the Playwright auth spec (they need a real DB + server).
 */
import { describe, expect, it } from "bun:test";
import { scopeFrom } from "../domain/scope";

describe("scopeFrom", () => {
  it("carries the authenticated user when present", () => {
    const scope = scopeFrom({ sid: "s1", user: { id: "u1", email: "a@x.com" } });
    expect(scope).toEqual({ sid: "s1", user: { id: "u1", email: "a@x.com" } });
  });

  it("is anonymous (no user) for a plain session", () => {
    expect(scopeFrom({ sid: "s2" })).toEqual({ sid: "s2", user: undefined });
  });

  it("falls back to an 'anonymous' sid for a malformed session", () => {
    expect(scopeFrom({}).sid).toBe("anonymous");
    expect(scopeFrom(null).sid).toBe("anonymous");
  });
});
