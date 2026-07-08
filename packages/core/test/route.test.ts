import { describe, expect, it } from "vitest";
import { isRoute, matchHttpPath, matchHttpRoute, route } from "../src/index.ts";

describe("route()", () => {
  it("builds a $route object carrying method handlers", () => {
    const r = route("/api/webhooks/stripe").post(() => new Response("ok"));
    expect(r.$route).toBe(true);
    expect(r.path).toBe("/api/webhooks/stripe");
    expect(Object.keys(r.def.handlers)).toEqual(["POST"]);
    expect(isRoute(r)).toBe(true);
  });

  it("chains multiple methods without a terminal call", () => {
    const r = route("/api/thing")
      .get(() => new Response("g"))
      .post(() => new Response("p"));
    expect(Object.keys(r.def.handlers).sort()).toEqual(["GET", "POST"]);
  });

  it("all() registers the ALL fallback", () => {
    const r = route("/api/auth/$").all(() => new Response("a"));
    expect(Object.keys(r.def.handlers)).toEqual(["ALL"]);
  });

  it("is immutable per step (each method returns a fresh object)", () => {
    const base = route("/x");
    const withGet = base.get(() => new Response("g"));
    expect(Object.keys(base.def.handlers)).toEqual([]);
    expect(Object.keys(withGet.def.handlers)).toEqual(["GET"]);
  });

  it("isRoute rejects non-route values", () => {
    expect(isRoute({ $live: true })).toBe(false);
    expect(isRoute(null)).toBe(false);
    expect(isRoute("nope")).toBe(false);
  });
});

describe("matchHttpPath", () => {
  it("matches exact paths", () => {
    expect(matchHttpPath("/api/health", "/api/health")).toEqual({});
    expect(matchHttpPath("/api/health", "/api/other")).toBeNull();
  });

  it("captures $name segments", () => {
    expect(matchHttpPath("/hook/$id", "/hook/42")).toEqual({ id: "42" });
    expect(matchHttpPath("/hook/$id", "/hook/42/extra")).toBeNull();
  });

  it("captures a trailing $ catch-all, including empty", () => {
    expect(matchHttpPath("/api/auth/$", "/api/auth/sign-in")).toEqual({ $: "sign-in" });
    expect(matchHttpPath("/api/auth/$", "/api/auth/sign-in/email")).toEqual({
      $: "sign-in/email",
    });
    expect(matchHttpPath("/api/auth/$", "/api/auth")).toEqual({ $: "" });
    expect(matchHttpPath("/api/auth/$", "/api/other")).toBeNull();
  });

  it("decodes percent-encoded segments", () => {
    expect(matchHttpPath("/hook/$id", "/hook/a%20b")).toEqual({ id: "a b" });
  });
});

describe("matchHttpRoute", () => {
  it("prefers static over catch-all", () => {
    const paths = ["/api/$", "/api/health"];
    expect(matchHttpRoute(paths, "/api/health")?.path).toBe("/api/health");
    expect(matchHttpRoute(paths, "/api/auth/x")?.path).toBe("/api/$");
  });

  it("returns captured params", () => {
    expect(matchHttpRoute(["/api/auth/$"], "/api/auth/session")).toEqual({
      path: "/api/auth/$",
      params: { $: "session" },
    });
  });
});
