/**
 * Tracer-bullet acceptance test (runs under `bun test`).
 *
 * Boots the real `rpxd dev` shell (one Bun process: Vite middleware + rpxd
 * runtime on one port, §14) against the todos example and drives the whole
 * pipeline: SSR mount → bootstrap payload → client-entry transform → SSE
 * attach → rpc → patch ack → warm-instance SSR reuse.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { fileURLToPath } from "node:url";
import { createDevServer, type DevServer } from "@rpxd/cli";

const root = fileURLToPath(new URL("..", import.meta.url));
let server: DevServer;
const base = () => `http://localhost:${server.port}`;
const COOKIE = "rpxd_sid=tracer-session";

interface BootPayload {
  instance: string;
  seq: number;
  attachToken: string;
  snapshot: { state: { todos: { id: string; text: string; done: boolean }[] } };
  path: string;
}

function bootFrom(html: string): BootPayload {
  const json = /<script id="__rpxd" type="application\/json">(.*?)<\/script>/s.exec(html)?.[1];
  if (!json) throw new Error("bootstrap payload missing from SSR html");
  return JSON.parse(json);
}

beforeAll(async () => {
  server = await createDevServer(root, { port: 0 });
});

afterAll(async () => {
  await server.close();
});

describe("tracer bullet: todos example through rpxd dev", () => {
  it("SSRs the todos page with state rendered and bootstrap embedded (§12, §14)", async () => {
    const res = await fetch(`${base()}/`, { headers: { cookie: COOKIE } });
    expect(res.status).toBe(200);
    const html = await res.text();

    // server-rendered live state, not a client shell
    expect(html).toContain("Try rpxd");
    expect(html).toContain('data-testid="todos"');
    // bootstrap: { snapshot, seq, attachToken } (§12)
    const boot = bootFrom(html);
    expect(boot.snapshot.state.todos[0]?.text).toBe("Try rpxd");
    expect(boot.attachToken).toBeTruthy();
    expect(boot.path).toBe("/");
    // framework-owned client entry is wired in (§14 zero-config)
    expect(html).toContain('src="/@rpxd-entry.tsx"');
  });

  it("serves the transformed client entry (hydration + live connection)", async () => {
    const res = await fetch(`${base()}/@rpxd-entry.tsx`);
    expect(res.status).toBe(200);
    const js = await res.text();
    expect(js).toContain("hydrateRoot");
    expect(js).toContain("LiveConnection");
  });

  it("attaches over SSE and round-trips an rpc into a patch ack (§2, §11)", async () => {
    const html = await (await fetch(`${base()}/`, { headers: { cookie: COOKIE } })).text();
    const boot = bootFrom(html);

    const streamRes = await fetch(
      `${base()}/__rpxd/stream?attach=${boot.attachToken}&seq=${boot.seq}`,
      { headers: { cookie: COOKIE } },
    );
    expect(streamRes.headers.get("content-type")).toContain("text/event-stream");
    const reader = (streamRes.body as ReadableStream<Uint8Array>).getReader();

    const rpcRes = await fetch(`${base()}/__rpxd/rpc`, {
      method: "POST",
      headers: { cookie: COOKIE, "content-type": "application/json" },
      body: JSON.stringify({
        v: 1,
        instance: boot.instance,
        rpcId: "tracer-1",
        calls: [{ rpc: "add", payload: { text: "from the wire" } }],
      }),
    });
    expect(rpcRes.status).toBe(202);

    // read SSE until the ack envelope arrives
    const decoder = new TextDecoder();
    let buf = "";
    const deadline = Date.now() + 5000;
    let ack: { rpcId?: string; patches?: { op: string; value?: unknown }[] } | undefined;
    while (!ack && Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value);
      for (const chunk of buf.split("\n\n")) {
        const data = chunk.split("\n").find((l) => l.startsWith("data: "));
        if (!data) continue;
        const env = JSON.parse(data.slice(6));
        if (env.rpcId === "tracer-1") ack = env;
      }
    }
    expect(ack).toBeDefined();
    expect(ack?.patches?.[0]?.op).toBe("add");
    expect((ack?.patches?.[0]?.value as { text: string }).text).toBe("from the wire");
    reader.cancel();
  });

  it("re-SSRs the same session against the warm instance (state persists)", async () => {
    const html = await (await fetch(`${base()}/`, { headers: { cookie: COOKIE } })).text();
    expect(html).toContain("from the wire"); // per-session instance kept the rpc result
  });

  it("mounts fresh state for a different session (per-session instances, §1)", async () => {
    const html = await (
      await fetch(`${base()}/`, { headers: { cookie: "rpxd_sid=other-session" } })
    ).text();
    expect(html).not.toContain("from the wire");
    expect(html).toContain("Try rpxd");
  });
});
