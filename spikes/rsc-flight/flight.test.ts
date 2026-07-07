/**
 * RSC Flight spike (§16 step 2) under `bun test`:
 *
 * 1. The `rsc` environment (react-server condition) serializes a subtree
 *    containing a 'use client' island into a Flight payload string — the
 *    value an rpxd handler would store in state.
 * 2. The payload carries static server markup inline and the island as a
 *    module REFERENCE (code split), not inlined markup.
 * 3. The `ssr` environment deserializes the payload and renders HTML with
 *    the island's SSR output in place.
 *
 * This is the load-bearing evidence that `@vitejs/plugin-rsc` environments
 * can back rpxd's RSC fields with our own server owning the request loop
 * (`serverHandler: false`) on Vite-on-Bun.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { fileURLToPath } from "node:url";
import { createServer, createServerModuleRunner, type ViteDevServer } from "vite";

const root = fileURLToPath(new URL(".", import.meta.url));

let server: ViteDevServer;
let payload: string;

beforeAll(async () => {
  server = await createServer({ configFile: `${root}/vite.config.ts`, root });
  const rscEnv = server.environments.rsc;
  if (!rscEnv) throw new Error("plugin-rsc did not register the rsc environment");
  const runner = createServerModuleRunner(rscEnv);
  const entry = await runner.import<typeof import("./src/entry.rsc.tsx")>("/src/entry.rsc.tsx");
  payload = await entry.serializeDoc("hello flight");
});

afterAll(async () => {
  await server?.close();
});

describe("rsc environment → Flight payload (§16)", () => {
  it("serializes server markup inline", () => {
    expect(payload).toContain("hello flight");
    expect(payload).toContain("never shipped to the client");
  });

  it("carries the island as a module reference, not markup", () => {
    expect(payload).toContain("counter.tsx"); // client-reference id points at the module
    expect(payload).not.toContain("count:"); // the island's rendering is deferred
  });
});

describe("ssr environment ← Flight payload", () => {
  it("deserializes and renders HTML including the island's SSR output", async () => {
    const ssrEnv = server.environments.ssr;
    const runner = createServerModuleRunner(ssrEnv);
    const entry = await runner.import<typeof import("./src/entry.ssr.tsx")>("/src/entry.ssr.tsx");
    const html = await entry.htmlFromPayload(payload);
    expect(html).toContain("hello flight");
    expect(html).toContain('data-testid="counter"');
    expect(html).toContain("count: <!-- -->41");
  });
});
