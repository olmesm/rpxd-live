/**
 * Dev error overlay (§10, §14): runtime errors (mount rejection, handler
 * crash during SSR) render a framework error page with the real message and
 * a sourcemapped stack — Remix/Next style. Prod behaviour is the inverse
 * (generic message, no leak) and is covered in packages/cli/test-bun.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { fileURLToPath } from "node:url";
import { createDevServer, type DevServer } from "@rpxd/cli";

const root = fileURLToPath(new URL("..", import.meta.url));

let server: DevServer;

beforeAll(async () => {
  server = await createDevServer(root, { port: 0 });
});

afterAll(async () => {
  await server.close();
});

describe("dev error page (§14)", () => {
  it("shows the real error with a sourcemapped stack", async () => {
    const res = await fetch(`http://localhost:${server.port}/boom`);
    expect(res.status).toBe(500);
    const html = await res.text();
    expect(html).toContain("rpxd-dev-error"); // framework overlay, not the app __error page
    expect(html).toContain("mount exploded"); // real message, dev only
    expect(html).toContain("boom.tsx"); // sourcemapped frame pointing at the route file
  });
});
