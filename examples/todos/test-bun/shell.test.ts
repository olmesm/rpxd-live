/**
 * TDD acceptance for the zero-config app shell files (§14):
 * __root.tsx (HTML shell + providers), __404.tsx (unmatched URL),
 * __error.tsx (mount rejection / handler crash).
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { fileURLToPath } from "node:url";
import { createDevServer, type DevServer } from "@rpxd/cli";

const root = fileURLToPath(new URL("..", import.meta.url));
let server: DevServer;
const base = () => `http://localhost:${server.port}`;

beforeAll(async () => {
  server = await createDevServer(root, { port: 0 });
});

afterAll(async () => {
  await server.close();
});

describe("__root.tsx (§14)", () => {
  it("wraps SSR'd pages in the userland HTML shell", async () => {
    const res = await fetch(`${base()}/`, { headers: { cookie: "rpxd_sid=shell" } });
    const html = await res.text();
    expect(html).toContain('data-shell="todos-root"'); // marker from __root.tsx
    expect(html).toContain("Try rpxd"); // live page still rendered inside it
    expect(html).toContain('id="__rpxd"'); // bootstrap still embedded
  });
});

describe("__404.tsx (§14)", () => {
  it("renders the userland 404 page for unmatched URLs", async () => {
    const res = await fetch(`${base()}/definitely/not/a/route`);
    expect(res.status).toBe(404);
    const html = await res.text();
    expect(html).toContain('data-testid="not-found"');
    expect(html).toContain("/definitely/not/a/route"); // page shows the missed path
  });
});

describe("__error.tsx (§10, §14)", () => {
  it("renders the userland error page when mount rejects", async () => {
    const res = await fetch(`${base()}/boom`, { headers: { cookie: "rpxd_sid=shell" } });
    expect(res.status).toBe(500);
    const html = await res.text();
    expect(html).toContain('data-testid="error-page"');
    expect(html).toContain("mount exploded"); // the thrown message surfaces
  });
});
