/**
 * Origin policy (#52): the control plane (`/__rpxd/ws|stream|rpc|control`) is
 * same-origin by default — the cross-site WebSocket-hijack / CSRF defense.
 * These cover the pure `originAllowed` predicate and the WS upgrade gate; the
 * SSE/POST paths are exercised in `handler.test.ts`.
 */
import type { LiveDefinition } from "@rpxd/core";
import { describe, expect, it } from "vitest";
import { createRpxdHandler } from "../src/handler.ts";
import { originAllowed } from "../src/origin.ts";
import { wsTransport } from "../src/ws.ts";

const base = "http://app.example/__rpxd/ws";
function req(headers: Record<string, string>): Request {
  return new Request(base, { headers });
}

describe("originAllowed (#52)", () => {
  it("allows an absent Origin — non-browser clients aren't the CSWSH threat", () => {
    expect(originAllowed(req({}))).toBe(true);
  });

  it("allows a same-origin request (Origin authority matches the target host)", () => {
    // No Host header on a synthetic Request → falls back to the URL's host.
    expect(originAllowed(req({ origin: "http://app.example" }))).toBe(true);
  });

  it("allows same-origin regardless of Origin/host casing", () => {
    expect(originAllowed(req({ origin: "http://APP.example", host: "app.example" }))).toBe(true);
  });

  it("rejects a cross-origin request by default", () => {
    expect(originAllowed(req({ origin: "http://evil.example" }))).toBe(false);
  });

  it("rejects the opaque `null` origin by default (sandboxed/file pages)", () => {
    expect(originAllowed(req({ origin: "null" }))).toBe(false);
  });

  it("allows a cross-origin request present in the array allowlist", () => {
    expect(
      originAllowed(req({ origin: "http://trusted.example" }), ["http://trusted.example"]),
    ).toBe(true);
    expect(originAllowed(req({ origin: "http://evil.example" }), ["http://trusted.example"])).toBe(
      false,
    );
  });

  it('treats "*" as an explicit opt-out (any origin allowed)', () => {
    expect(originAllowed(req({ origin: "http://evil.example" }), ["*"])).toBe(true);
  });

  it("supports a predicate for full control", () => {
    const allow = (o: string) => o.endsWith(".trusted.example");
    expect(originAllowed(req({ origin: "http://a.trusted.example" }), allow)).toBe(true);
    expect(originAllowed(req({ origin: "http://a.evil.example" }), allow)).toBe(false);
  });
});

const def: LiveDefinition<{ n: number }, "/", Record<string, unknown>> = {
  setup: () => ({ n: 0 }),
  rpc: {},
};

describe("ws upgrade origin gate (#52)", () => {
  // The success path (a real 101 upgrade) is asserted under `bun test` in
  // test-bun/ws.test.ts — Node's `Response` rejects status 101, so here we only
  // cover the 403 rejection, which never constructs the 101 sentinel.
  it("rejects a cross-origin upgrade with 403 before upgrading", async () => {
    const handler = createRpxdHandler({ routes: [{ path: "/", def }] });
    const ws = wsTransport(handler);
    let upgraded = false;
    const res = await ws.handleUpgrade(
      new Request(base, { headers: { origin: "http://evil.example" } }),
      () => {
        upgraded = true;
        return true;
      },
    );
    expect(res?.status).toBe(403);
    expect(upgraded).toBe(false); // gated before the upgrade fn runs
  });
});
