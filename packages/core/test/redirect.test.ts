import { describe, expect, it } from "vitest";
import { isRedirect, RedirectError, redirect } from "../src/index.ts";

describe("redirect()", () => {
  it("builds a RedirectError with location and default 302", () => {
    const r = redirect("/login");
    expect(r).toBeInstanceOf(RedirectError);
    expect(r.location).toBe("/login");
    expect(r.status).toBe(302);
  });

  it("accepts a custom status", () => {
    expect(redirect("/x", 307).status).toBe(307);
  });

  it("isRedirect recognises the signal (branded, cross-realm safe)", () => {
    expect(isRedirect(redirect("/login"))).toBe(true);
    // a plain object with the brand also passes (survives instanceof gaps)
    expect(isRedirect({ $redirect: true, location: "/x" })).toBe(true);
  });

  it("isRedirect rejects other errors and values", () => {
    expect(isRedirect(new Error("nope"))).toBe(false);
    expect(isRedirect(null)).toBe(false);
    expect(isRedirect("/login")).toBe(false);
  });
});
