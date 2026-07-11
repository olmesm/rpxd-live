/**
 * TDD acceptance for the dev server's config forwarding (§14): `rpxd dev`
 * must apply the same `instances.*` capacity knobs and `onDiagnostic` observability
 * sink that `rpxd start` does — the wiring is one spread, but only a booted
 * dev server proves it reaches the running handler. Injected through
 * `configOverride`, the test/embedding seam over `rpxd.config.ts`.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { fileURLToPath } from "node:url";
import type { RpxdDiagnostic } from "@rpxd/server-bun";
import { createDevServer, type DevServer } from "../src/index.ts";

const exampleRoot = fileURLToPath(new URL("../../../examples/kitchen-sink", import.meta.url));
const COOKIE = "rpxd_sid=dev-config-session";

let server: DevServer;
const events: RpxdDiagnostic[] = [];

beforeAll(async () => {
  server = await createDevServer(exampleRoot, {
    port: 0,
    configOverride: {
      instances: { maxInstancesPerSession: 1 },
      onDiagnostic: (e) => events.push(e),
    },
  });
}, 60_000);

afterAll(async () => {
  await server?.close();
});

const base = () => `http://localhost:${server.port}`;

async function mount(path: string): Promise<Response> {
  return fetch(`${base()}/__rpxd/control`, {
    method: "POST",
    headers: { cookie: COOKIE, "content-type": "application/json" },
    body: JSON.stringify({ type: "mount", path }),
  });
}

describe("rpxd dev applies instances.* and onDiagnostic from config", () => {
  it("forwards onDiagnostic: a cross-origin control-plane POST fires origin-rejected", async () => {
    const res = await fetch(`${base()}/__rpxd/rpc`, {
      method: "POST",
      headers: {
        cookie: COOKIE,
        origin: "https://evil.example",
        "content-type": "application/json",
      },
      body: JSON.stringify({ v: 1, instance: "x", rpcId: "r1", calls: [] }),
    });
    expect(res.status).toBe(403);
    expect(events.some((e) => e.type === "origin-rejected")).toBe(true);
  });

  it("forwards instances caps: a second mount under maxInstancesPerSession=1 evicts the first", async () => {
    expect((await mount("/")).status).toBe(200);
    expect((await mount("/stream")).status).toBe(200); // at the cap → oldest idle instance shed
    expect(events.some((e) => e.type === "cap-evicted")).toBe(true);
  });
});
