import { describe, expect, it } from "vitest";
import { matchPath, matchRoute } from "../src/match.ts";

describe("matchPath / matchRoute (§7)", () => {
  it("captures $params and rejects mismatches", () => {
    expect(matchPath("/org/$orgId/board", "/org/42/board")).toEqual({ orgId: "42" });
    expect(matchPath("/org/$orgId/board", "/org/42/list")).toBeNull();
    expect(matchPath("/", "/")).toEqual({});
    expect(matchPath("/a", "/a/b")).toBeNull();
  });

  it("decodes URI-encoded param segments", () => {
    expect(matchPath("/tag/$name", "/tag/a%20b")).toEqual({ name: "a b" });
  });

  it("prefers static routes over param routes", () => {
    const paths = ["/$slug", "/about"];
    expect(matchRoute(paths, "/about")).toEqual({ path: "/about", params: {} });
    expect(matchRoute(paths, "/other")).toEqual({ path: "/$slug", params: { slug: "other" } });
    expect(matchRoute(paths, "/a/b")).toBeNull();
  });
});
