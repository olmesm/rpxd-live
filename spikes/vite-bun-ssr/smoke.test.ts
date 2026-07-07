/**
 * Runs under `bun test` (NOT vitest) — the whole point is verifying the Vite
 * dev pipeline works on the Bun runtime.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { type SmokeServer, startSmokeServer } from "./server.ts";

let server: SmokeServer;

beforeAll(async () => {
  server = await startSmokeServer();
});

afterAll(async () => {
  await server.close();
});

describe("vite-on-bun SSR", () => {
  it("serves server-rendered HTML through Vite middleware mode", async () => {
    const res = await fetch(`http://localhost:${server.port}/`);
    expect(res.status).toBe(200);
    const html = await res.text();
    // SSR output present (rendered on the server, not a client shell)
    expect(html).toContain('data-testid="ssr-marker"');
    // React may emit `<!-- -->` separators between text nodes — match loosely
    expect(html).toContain("smoke-run");
    // transformIndexHtml injected the HMR client → dev pipeline is live
    expect(html).toContain("/@vite/client");
  });

  it("transforms client modules (TSX → JS) on demand", async () => {
    const res = await fetch(`http://localhost:${server.port}/src/entry-client.tsx`);
    expect(res.status).toBe(200);
    const js = await res.text();
    expect(js).toContain("hydrateRoot");
    // JSX must be compiled away in the served module
    expect(js).not.toContain("<App");
  });

  it("serves the Vite HMR client", async () => {
    const res = await fetch(`http://localhost:${server.port}/@vite/client`);
    expect(res.status).toBe(200);
    expect(await res.text()).toMatch(/HMRContext|createHotContext/);
  });

  it("re-renders through ssrLoadModule with module graph caching", async () => {
    const first = await (await fetch(`http://localhost:${server.port}/`)).text();
    const second = await (await fetch(`http://localhost:${server.port}/`)).text();
    expect(second).toBe(first);
  });
});
