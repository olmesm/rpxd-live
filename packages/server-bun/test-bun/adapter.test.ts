/**
 * Runs under `bun test` — exercises the real Bun.serve adapter end-to-end
 * (the ServerAdapter seam, §14).
 */
import { describe, expect, it } from "bun:test";
import type { LiveDefinition } from "@rpxd/core";
import { bunAdapter } from "../src/adapter.ts";
import { createRpxdHandler } from "../src/handler.ts";

const def: LiveDefinition<{ n: number }, "/", Record<string, unknown>> = {
  mount: async () => ({ n: 1 }),
};

describe("bunAdapter", () => {
  it("serves the rpxd handler over real HTTP", async () => {
    const handler = createRpxdHandler({ routes: [{ path: "/", def }], warmTtlMs: 10 });
    const handle = bunAdapter().serve({ port: 0, fetch: handler.fetch });

    const res = await fetch(`http://localhost:${handle.port}/`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('"state":{"n":1}');
    expect(res.headers.get("set-cookie")).toContain("rpxd_sid=");

    await handler.dispose();
    await handle.stop();
  });

  it("reads env through the seam", () => {
    process.env.RPXD_TEST_ENV = "yes";
    expect(bunAdapter().env("RPXD_TEST_ENV")).toBe("yes");
  });
});
