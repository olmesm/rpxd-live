/**
 * TDD acceptance for `rpxd build` + `rpxd start` (§14): `vite build` produces
 * client + SSR bundles; `start` serves them from pure Bun — no Vite at
 * runtime — with SSR, hashed assets, and the live wire fully working.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildApp, type StartedApp, startApp } from "../src/index.ts";

const exampleRoot = fileURLToPath(new URL("../../../examples/todos", import.meta.url));
const distDir = join(exampleRoot, "dist");
let app: StartedApp;
const COOKIE = "rpxd_sid=prod-session";

beforeAll(async () => {
  rmSync(distDir, { recursive: true, force: true });
  await buildApp(exampleRoot);
  app = await startApp(exampleRoot, { port: 0 });
}, 120_000);

afterAll(async () => {
  await app?.close();
});

describe("rpxd build", () => {
  it("emits client and server bundles with a manifest", () => {
    expect(existsSync(join(distDir, "client/.vite/manifest.json"))).toBe(true);
    expect(existsSync(join(distDir, "server/entry-server.js"))).toBe(true);
  });
});

describe("rpxd start (pure Bun, no Vite)", () => {
  const base = () => `http://localhost:${app.port}`;

  it("SSRs pages with live state and a hashed client entry", async () => {
    const res = await fetch(`${base()}/`, { headers: { cookie: COOKIE } });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Try rpxd");
    expect(html).toContain('id="__rpxd"');
    // hashed asset from the client build, not the dev virtual entry
    const src = /<script type="module" src="(\/assets\/[^"]+\.js)"><\/script>/.exec(html)?.[1];
    expect(src).toBeTruthy();

    const asset = await fetch(`${base()}${src}`);
    expect(asset.status).toBe(200);
    expect(asset.headers.get("content-type")).toContain("javascript");
    expect(await asset.text()).toContain("hydrateRoot");
  });

  it("runs the live wire end-to-end in production mode", async () => {
    const html = await (await fetch(`${base()}/`, { headers: { cookie: COOKIE } })).text();
    const boot = JSON.parse(
      /<script id="__rpxd" type="application\/json">(.*?)<\/script>/s.exec(html)?.[1] as string,
    );

    const streamRes = await fetch(
      `${base()}/__rpxd/stream?attach=${boot.attachToken}&seq=${boot.seq}`,
      { headers: { cookie: COOKIE } },
    );
    const reader = (streamRes.body as ReadableStream<Uint8Array>).getReader();

    const rpcRes = await fetch(`${base()}/__rpxd/rpc`, {
      method: "POST",
      headers: { cookie: COOKIE, "content-type": "application/json" },
      body: JSON.stringify({
        v: 1,
        instance: boot.instance,
        rpcId: "prod-1",
        calls: [{ rpc: "add", payload: { text: "built and served" } }],
      }),
    });
    expect(rpcRes.status).toBe(202);

    const decoder = new TextDecoder();
    let buf = "";
    let ack: { rpcId?: string } | undefined;
    const deadline = Date.now() + 5000;
    while (!ack && Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value);
      for (const chunk of buf.split("\n\n")) {
        const data = chunk.split("\n").find((l) => l.startsWith("data: "));
        if (data && JSON.parse(data.slice(6)).rpcId === "prod-1") ack = JSON.parse(data.slice(6));
      }
    }
    expect(ack).toBeDefined();
    reader.cancel();
  });

  it("404s unknown paths", async () => {
    const res = await fetch(`${base()}/definitely/not/here`);
    expect(res.status).toBe(404);
  });

  it("hardens runtime errors: generic 500 into __error, no message leak (§10)", async () => {
    const res = await fetch(`${base()}/boom`, { headers: { cookie: COOKIE } });
    expect(res.status).toBe(500);
    const html = await res.text();
    expect(html).toContain("error-page"); // the app's __error shell page
    expect(html).not.toContain("mount exploded"); // details stay server-side
    expect(html).toMatch(/ref: [0-9a-f]{8}/); // correlate with the server log
  });
});
