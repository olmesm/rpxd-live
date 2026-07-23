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
  // S1: signing is on by default (an ephemeral per-instance secret in dev),
  // which would reject the fixed literal `COOKIE` above as forged on every
  // request. This suite is about reducer HMR, not cookie signing, so opt
  // into the explicit unsigned escape hatch. `configOverride` shallow-merges
  // `session`, so this also replaces kitchen-sink's own `session.authenticate` —
  // reinstate a minimal one (just `sid`, no real auth backend) since the todos
  // domain layer scopes rows by `ctx.session.sid` (see domain/scope.ts).
  server = await createDevServer(root, {
    port: 0,
    configOverride: {
      session: { authenticate: (_req, { sid }) => ({ sid }), cookie: { sign: false } },
    },
  });
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
      // Instances are stream-scoped (ADR 0003): name the tab's stream so the
      // SSE reader below (same stream id) subscribes this exact instance.
      body: JSON.stringify({ type: "mount", path: "/hmr-probe", stream: "hmr-s1" }),
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
    // Read the live instance's state over its own stream (ADR 0003: a page GET
    // would build a FRESH instance now, not warm-reuse this one): open the
    // mount's stream, which resyncs its instances on connect, and take the
    // full snapshot for this instance.
    const ctrl = new AbortController();
    const res = await fetch(`${base()}/__rpxd/stream?stream=hmr-s1`, {
      headers: { cookie: COOKIE },
      signal: ctrl.signal,
    });
    try {
      const reader = (res.body as ReadableStream<Uint8Array>).getReader();
      const decoder = new TextDecoder();
      let buf = "";
      const deadline = Date.now() + 3000;
      while (Date.now() < deadline) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value);
        for (const chunk of buf.split("\n\n")) {
          const data = chunk.split("\n").find((l) => l.startsWith("data: "));
          if (!data) continue;
          const env = JSON.parse(data.slice(6)) as {
            instance?: string;
            full?: { state: { n: number } };
          };
          if (env.instance === instance && env.full) return { n: env.full.state.n };
        }
      }
      throw new Error("no full snapshot for the probe instance");
    } finally {
      ctrl.abort();
    }
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
