/**
 * TDD acceptance for reducer HMR (§15): editing a route file while
 * `rpxd dev` runs swaps the reducers WITHOUT losing instance state.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createDevServer, type DevServer } from "@rpxd/cli";
import { runCodegen } from "@rpxd/vite-plugin";

const root = fileURLToPath(new URL("..", import.meta.url));
const probeFile = join(root, "routes", "hmr-probe.tsx");
const COOKIE = "rpxd_sid=hmr-session";

const routeSource = (increment: number) => `import { live } from "@rpxd/core";

export default live("/hmr-probe")
  .setup(() => ({ n: 0 }))
  .rpc("bump", (r) =>
    r.handler(async (_payload, ctx) => {
      ctx.patchState((state) => {
        state.n += ${increment};
      });
    }),
  )
  .render(({ state }) => <main data-n={state.n}>{state.n}</main>);
`;

let server: DevServer;

beforeAll(async () => {
  writeFileSync(probeFile, routeSource(1));
  server = await createDevServer(root, { port: 0 });
});

afterAll(async () => {
  await server.close();
  rmSync(probeFile, { force: true });
  runCodegen(root); // drop the probe from routes.gen.ts
});

describe("reducer HMR (§15)", () => {
  const base = () => `http://localhost:${server.port}`;

  async function mountProbe(): Promise<string> {
    const res = await fetch(`${base()}/__rpxd/control`, {
      method: "POST",
      headers: { cookie: COOKIE },
      body: JSON.stringify({ type: "mount", path: "/hmr-probe" }),
    });
    return (await res.json()).instance;
  }

  async function bump(instance: string, rpcId: string): Promise<void> {
    await fetch(`${base()}/__rpxd/rpc`, {
      method: "POST",
      headers: { cookie: COOKIE, "content-type": "application/json" },
      body: JSON.stringify({ v: 1, instance, rpcId, calls: [{ rpc: "bump", payload: {} }] }),
    });
  }

  async function stateOf(instance: string): Promise<{ n: number }> {
    // second mount for the same session returns the same warm instance;
    // read state via SSR of the page
    const res = await fetch(`${base()}/hmr-probe`, { headers: { cookie: COOKIE } });
    const html = await res.text();
    const n = /data-n="(\d+)"/.exec(html)?.[1];
    return { n: Number(n) };
  }

  it("swaps reducers on file edit while preserving runtime state", async () => {
    const instance = await mountProbe();

    await bump(instance, "h1");
    await new Promise((r) => setTimeout(r, 100));
    expect((await stateOf(instance)).n).toBe(1);

    // edit the reducer on disk: bump by 10 instead of 1
    writeFileSync(probeFile, routeSource(10));
    // wait for the watcher + module reload to land
    await new Promise((r) => setTimeout(r, 700));

    await bump(instance, "h2");
    await new Promise((r) => setTimeout(r, 100));
    // state preserved (1) + new reducer applied (+10)
    expect((await stateOf(instance)).n).toBe(11);
  });
});
