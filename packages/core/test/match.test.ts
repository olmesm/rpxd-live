import { describe, expect, it } from "vitest";
import { matchHttpPath, matchPath, matchRoute } from "../src/match.ts";

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

  it("treats malformed percent-encoding as a non-match, not a thrown URIError", () => {
    // `%zz` / lone `%` / truncated multibyte all make decodeURIComponent throw.
    expect(() => matchPath("/tag/$name", "/tag/%zz")).not.toThrow();
    expect(matchPath("/tag/$name", "/tag/%zz")).toBeNull();
    expect(matchPath("/tag/$name", "/tag/%")).toBeNull();
    expect(matchRoute(["/tag/$name"], "/tag/%e0%a4%a")).toBeNull();
    // HTTP matcher: both a named segment and the catch-all tail.
    expect(matchHttpPath("/hook/$id", "/hook/%zz")).toBeNull();
    expect(matchHttpPath("/api/$", "/api/ok/%zz")).toBeNull();
  });
});
