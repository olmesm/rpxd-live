import { describe, expect, it } from "vitest";
import { nodeRequestUrl } from "../src/http-bridge.ts";

describe("nodeRequestUrl", () => {
  it("builds an absolute URL from a well-formed request", () => {
    expect(nodeRequestUrl({ headers: { host: "localhost:3000" }, url: "/foo?x=1" })).toBe(
      "http://localhost:3000/foo?x=1",
    );
    // Missing host falls back to localhost; missing target to "/".
    expect(nodeRequestUrl({ headers: {}, url: undefined })).toBe("http://localhost/");
  });

  it("returns null for a malformed Host instead of throwing", () => {
    // A space makes the authority invalid; an empty Host yields `http://`.
    expect(nodeRequestUrl({ headers: { host: "exa mple.com" }, url: "/" })).toBeNull();
    expect(nodeRequestUrl({ headers: { host: "" }, url: "/" })).toBeNull();
  });
});
