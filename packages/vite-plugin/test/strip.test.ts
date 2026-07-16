/**
 * TDD for the client-build strip transform (ADR 0002 item 5): server-only
 * chain steps of a registered live module must never reach the browser. The
 * transform stubs `.setup`/`.guard`/`.load`/`.on` handlers and rpc
 * `.handler`/`.onError` args with a throwing `__rpxdServerStub`, keeps
 * `.input`/`.optimistic`/pattern/props schema/`.render`, then prunes imports
 * that were referenced *exclusively* inside the stripped spans.
 */
import * as ts from "typescript";
import { describe, expect, it } from "vitest";
import { rpxd } from "../src/index.ts";
import { stripLiveModule } from "../src/strip.ts";

/** Assert transformed output re-parses with zero syntactic errors. */
function parsesClean(code: string): boolean {
  const sf = ts.createSourceFile("out.tsx", code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  // parseDiagnostics is internal but populated for syntactic errors.
  const diags = (sf as unknown as { parseDiagnostics: unknown[] }).parseDiagnostics;
  return diags.length === 0;
}

const FIXTURE_A = `import { live } from "@rpxd/core";
import { z } from "zod";
import { readFileSync } from "node:fs";
import { renderRow } from "./ui";

export default live("/report/$id", z.object({ limit: z.number() }))
  .setup(() => ({ rows: [] as string[], pending: 0 }))
  .load(async ({ params, props }, ctx) => {
    const raw = readFileSync(\`/data/\${params.id}\`, "utf8");
    ctx.patchState((s) => {
      s.rows = raw.split("\\n").slice(0, props.limit);
    });
  })
  .on("row.added", (state, row) => {
    state.rows.push(row);
  })
  .rpc("add", (r) =>
    r
      .input(z.object({ text: z.string() }))
      .optimistic((state, { text }, { tempId }) => {
        state.rows.push(tempId() + text);
        state.pending++;
      })
      .handler(async ({ text }, ctx) => {
        readFileSync("/x");
        ctx.patchState((s) => {
          s.pending--;
        });
      })
      .onError((state) => {
        state.pending--;
      }))
  .render(({ state }) => renderRow(state.rows));
`;

describe("stripLiveModule — strips server-only steps, keeps client steps", () => {
  it("removes a node:fs import used only in .load and .handler; keeps input/optimistic/schema/render", () => {
    const out = stripLiveModule(FIXTURE_A, "src/report.tsx");
    expect(out).not.toBeNull();
    const code = (out as { code: string }).code;

    // Server-only import and its bodies are gone.
    expect(code).not.toContain("node:fs");
    expect(code).not.toContain("readFileSync");
    expect(code).not.toContain("patchState"); // used only in load + handler
    expect(code).not.toContain("as string[]"); // setup body stripped
    expect(code).not.toContain("pending--"); // handler + onError bodies stripped

    // Client-relevant steps survive verbatim.
    expect(code).toContain("z.number()"); // props schema arg to live()
    expect(code).toContain('live("/report/$id"'); // pattern kept
    expect(code).toContain("z.object({ text: z.string() })"); // .input schema kept
    expect(code).toContain("state.pending++"); // optimistic body kept
    expect(code).toContain("tempId()"); // optimistic body kept
    expect(code).toContain("renderRow(state.rows)"); // render component kept
    expect(code).toContain("import { renderRow }"); // render's import kept

    // .on keeps the event name, stubs the handler.
    expect(code).toContain('"row.added"');
    expect(code).not.toContain("state.rows.push(row)"); // on handler stripped

    // Stub injected and documented.
    expect(code).toContain("function __rpxdServerStub");
    expect(code).toContain("rpxd: server-only code invoked on the client");

    // Structure intact.
    expect(code).toContain("export default");
    expect(parsesClean(code)).toBe(true);
  });

  it("keeps an import referenced in BOTH .load and .optimistic", () => {
    const src = `import { live } from "@rpxd/core";
import { z } from "zod";
import { format } from "./util";
export default live("/b")
  .setup(() => ({ v: "" }))
  .load(async (_u, ctx) => { ctx.patchState((s) => { s.v = format("load"); }); })
  .rpc("set", (r) => r.optimistic((state) => { state.v = format("opt"); }).handler(async () => {}))
  .render(() => null);
`;
    const code = (stripLiveModule(src, "b.tsx") as { code: string }).code;
    expect(code).toContain("import { format }");
    expect(code).toContain('from "./util"');
    expect(code).toContain('state.v = format("opt")'); // optimistic body kept
    expect(code).not.toContain('format("load")'); // load body stripped
    // A pre-existing unused import (z) is NOT touched — conservative.
    expect(code).toContain("import { z }");
    expect(parsesClean(code)).toBe(true);
  });

  it("never removes a side-effect import; leaves type-only imports alone; prunes value-only orphans", () => {
    const src = `import "./polyfill";
import type { Row } from "./types";
import { live } from "@rpxd/core";
import { load as loadData } from "./data";
export default live("/c")
  .setup(() => ({ rows: [] as Row[] }))
  .load(async (_u, ctx) => { const rows: Row[] = await loadData(); ctx.patchState((s) => { s.rows = rows; }); })
  .render(() => null);
`;
    const code = (stripLiveModule(src, "c.tsx") as { code: string }).code;
    expect(code).toContain('import "./polyfill";'); // side-effect kept
    expect(code).toContain("import type { Row }"); // type-only untouched
    expect(code).not.toContain("loadData"); // value import used only in load → pruned
    expect(code).not.toContain('from "./data"');
    expect(parsesClean(code)).toBe(true);
  });

  it("stubs rpc .handler/.onError, keeps .input/.optimistic", () => {
    const src = `import { live } from "@rpxd/core";
import { z } from "zod";
import { save } from "./db";
export default live("/d")
  .setup(() => ({ n: 0 }))
  .rpc("go", (r) =>
    r.input(z.object({ x: z.number() }))
     .optimistic((s) => { s.n++; })
     .handler(async ({ x }) => { await save(x); })
     .onError((s) => { s.n--; }))
  .render(() => null);
`;
    const code = (stripLiveModule(src, "d.tsx") as { code: string }).code;
    expect(code).toContain("z.object({ x: z.number() })"); // input kept
    expect(code).toContain("s.n++"); // optimistic kept
    expect(code).not.toContain("save(x)"); // handler stripped
    expect(code).not.toContain("s.n--"); // onError stripped
    expect(code).not.toContain('from "./db"'); // save import pruned
    expect(code).toContain("__rpxdServerStub");
    expect(parsesClean(code)).toBe(true);
  });

  it("returns null for a non-live module", () => {
    expect(stripLiveModule(`export const x = 1;`, "plain.ts")).toBeNull();
    expect(
      stripLiveModule(`import { live } from "@rpxd/core";\nexport const y = 2;`, "nolivecall.ts"),
    ).toBeNull();
  });

  it("is deterministic — identical source → byte-identical output", () => {
    const a = (stripLiveModule(FIXTURE_A, "src/report.tsx") as { code: string }).code;
    const b = (stripLiveModule(FIXTURE_A, "src/report.tsx") as { code: string }).code;
    expect(a).toBe(b);
  });

  it("produces a source map", () => {
    const out = stripLiveModule(FIXTURE_A, "src/report.tsx") as { code: string; map: unknown };
    expect(out.map).toBeTruthy();
    expect((out.map as { mappings: string }).mappings).toBeTypeOf("string");
  });
});

/**
 * Client meta extraction (`rpcMetaFromDef` reads `def.rpc[name].optimistic` +
 * `.input`) must still work on a *transformed* module. We evaluate the stripped
 * output against a fake `live`/`zod` (mirroring the real builder's storage
 * shape) with a require shim that throws if `node:fs` is ever imported — proving
 * the server-only import is gone and the client-relevant meta survives.
 */
describe("stripLiveModule — transformed module is client-consumable", () => {
  const NOJSX = `import { live } from "@rpxd/core";
import { z } from "zod";
import { readFileSync } from "node:fs";
export default live("/m")
  .setup(() => ({ n: 0 }))
  .load(async (_u, ctx) => { readFileSync("/x"); ctx.patchState((s) => { s.n = 1; }); })
  .rpc("inc", (r) =>
    r.input(z.object({ by: z.number() }))
     .optimistic((state, { by }) => { state.n += by; })
     .handler(async () => { readFileSync("/y"); }))
  .render(() => null);
`;

  function evalStripped(code: string): {
    def: { $live: boolean; path: string; def: Record<string, unknown> };
    required: Set<string>;
  } {
    const js = ts.transpileModule(code, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    }).outputText;

    // biome-ignore lint/suspicious/noExplicitAny: test fakes mirror the runtime builder's storage shape
    const makeRpcChain = (partial: Record<string, any>): any => ({
      input: (s: unknown) => makeRpcChain({ ...partial, input: s }),
      optimistic: (f: unknown) => makeRpcChain({ ...partial, optimistic: f }),
      handler: (f: unknown) => makeRpcChain({ ...partial, handler: f }),
      onError: (f: unknown) => makeRpcChain({ ...partial, onError: f }),
      rateLimit: (l: unknown) => makeRpcChain({ ...partial, rateLimit: l }),
      get def() {
        return partial;
      },
    });
    // biome-ignore lint/suspicious/noExplicitAny: test fakes mirror the runtime builder's storage shape
    const makeBuilder = (path: string, def: Record<string, any>, props: unknown): any => ({
      rpc: (name: string, build: (r: unknown) => { def: unknown }) =>
        makeBuilder(
          path,
          { ...def, rpc: { ...def.rpc, [name]: build(makeRpcChain({})).def } },
          props,
        ),
      on: (evt: string, h: unknown) =>
        makeBuilder(path, { ...def, on: { ...def.on, [evt]: h } }, props),
      guard: (g: unknown) => makeBuilder(path, { ...def, guard: g }, props),
      load: (l: unknown) => makeBuilder(path, { ...def, load: l }, props),
      version: (t: string) => makeBuilder(path, { ...def, version: t }, props),
      render: (c: unknown) => ({ $live: true, path, def, component: c, props }),
    });
    const fakeLive = (path: string, props: unknown) => ({
      setup: (fn: unknown) => makeBuilder(path, { setup: fn }, props),
    });
    const z = {
      object: (shape: unknown) => ({ __schema: "object", shape }),
      number: () => ({ __schema: "number" }),
      string: () => ({ __schema: "string" }),
    };

    const required = new Set<string>();
    const require = (spec: string): unknown => {
      required.add(spec);
      if (spec === "@rpxd/core") return { live: fakeLive };
      if (spec === "zod") return { z };
      throw new Error(`unexpected import on the client: ${spec}`);
    };
    const exports: Record<string, unknown> = {};
    new Function("require", "exports", js)(require, exports);
    return { def: exports.default as never, required };
  }

  it("evaluates without importing node:fs; optimistic + input survive; setup/handler are throwing stubs", () => {
    const out = stripLiveModule(NOJSX, "m.tsx") as { code: string };
    const { def, required } = evalStripped(out.code);

    expect(required.has("node:fs")).toBe(false); // server-only import gone
    expect(def.$live).toBe(true);
    expect(def.path).toBe("/m");

    // rpcMetaFromDef-equivalent extraction.
    const rpc = (def.def.rpc as Record<string, Record<string, unknown>>).inc as Record<
      string,
      unknown
    >;
    const meta = { optimistic: rpc.optimistic, input: rpc.input };
    expect(typeof meta.optimistic).toBe("function");
    expect(meta.input).toEqual({ __schema: "object", shape: { by: { __schema: "number" } } });

    // Optimistic fn actually runs (client replay path).
    const st = { n: 0 };
    (meta.optimistic as (s: unknown, p: unknown, c: unknown) => void)(
      st,
      { by: 5 },
      { tempId: () => "t" },
    );
    expect(st.n).toBe(5);

    // Server-only fns are throwing stubs — the client never invokes them, but
    // if a logic error ever does, it fails loud (ADR 0002 Decision 3).
    expect(() => (rpc.handler as () => void)()).toThrow("server-only");
    expect(() => (def.def.setup as () => void)()).toThrow("server-only");
  });
});

/**
 * Scope-aware import pruning (ADR 0002 item 5, review R1 finding 6): pruning
 * resolves each reference to its lexical binding, so an import whose only real
 * uses are inside stripped spans is pruned *even when* a kept step (`render`)
 * declares a local binding that shadows the import name. A genuine reference to
 * the import (no shadow) still keeps it — no false strips.
 */
describe("stripLiveModule — scope-aware pruning under shadowing", () => {
  const IMPORTS = `import { live } from "@rpxd/core";
import { db } from "./db";
import { useDb } from "./hooks";`;

  it("prunes an import used only in .load when .render declares a local `const db` shadow", () => {
    const src = `${IMPORTS}
export default live("/x")
  .setup(() => ({ rows: [] as string[] }))
  .load(async (_u, ctx) => { const rows = await db.query(); ctx.patchState((s) => { s.rows = rows; }); })
  .render(() => { const db = useDb(); return db.render(); });
`;
    const code = (stripLiveModule(src, "x.tsx") as { code: string }).code;
    expect(code).not.toContain('from "./db"'); // import used only in stripped .load → pruned
    expect(code).toContain("import { useDb }"); // genuinely used in render → kept
    expect(code).toContain('from "./hooks"');
    expect(parsesClean(code)).toBe(true);
  });

  it("keeps the import when .render references it genuinely (no shadow)", () => {
    const src = `${IMPORTS}
export default live("/y")
  .setup(() => ({ rows: [] as string[] }))
  .load(async (_u, ctx) => { const rows = await db.query(); ctx.patchState((s) => { s.rows = rows; }); })
  .render(({ state }) => db.render(state));
`;
    const code = (stripLiveModule(src, "y.tsx") as { code: string }).code;
    expect(code).toContain("import { db }"); // real outside reference → kept
    expect(code).toContain('from "./db"');
    expect(parsesClean(code)).toBe(true);
  });

  it("prunes under a `.render` arrow *parameter* shadow", () => {
    const src = `${IMPORTS}
export default live("/p")
  .setup(() => ({ n: 0 }))
  .load(async (_u) => { await db.query(); })
  .render((db) => db.render());
`;
    const code = (stripLiveModule(src, "p.tsx") as { code: string }).code;
    expect(code).not.toContain('from "./db"'); // param `db` shadows the import
    expect(parsesClean(code)).toBe(true);
  });

  it("prunes under a nested-arrow local shadow", () => {
    const src = `${IMPORTS}
export default live("/n")
  .setup(() => ({ rows: [] as string[] }))
  .load(async (_u) => { await db.query(); })
  .render(({ state }) => { const db = useDb(); return state.rows.map((x) => db.wrap(x)); });
`;
    const code = (stripLiveModule(src, "n.tsx") as { code: string }).code;
    expect(code).not.toContain('from "./db"'); // inner shadow, import only in .load
    expect(code).toContain("import { useDb }");
    expect(parsesClean(code)).toBe(true);
  });

  it("prunes under a destructured `const { db } = x` shadow", () => {
    const src = `${IMPORTS}
export default live("/z")
  .setup(() => ({ rows: [] as string[] }))
  .load(async (_u) => { await db.query(); })
  .render(({ state }) => { const { db } = state; return db.render(); });
`;
    const code = (stripLiveModule(src, "z.tsx") as { code: string }).code;
    expect(code).not.toContain('from "./db"'); // destructured shadow, import only in .load
    expect(parsesClean(code)).toBe(true);
  });

  it("KEEPS an import referenced in a KEPT render's COMPUTED member name (NEW-3 false shadow)", () => {
    // `[db.key]` is a computed member name: it evaluates in the ENCLOSING scope,
    // NOT the method's own param scope. Attributing that `db` to the method's
    // `db` parameter is a FALSE shadow → a FALSE prune → a client ReferenceError.
    // The computed name is a genuine outside use, so the import must be KEPT.
    const src = `${IMPORTS}
export default live("/c")
  .setup(() => ({ n: 0 }))
  .load(async (_u) => { await db.query(); })
  .render(() => { const o = { [db.key](db: unknown) { return db; } }; return o; });
`;
    const code = (stripLiveModule(src, "c.tsx") as { code: string }).code;
    expect(code).toContain("import { db }"); // computed name = real enclosing-scope use
    expect(code).toContain('from "./db"');
    expect(parsesClean(code)).toBe(true);
  });

  it("KEEPS an import referenced in a KEPT render's DECORATOR expression (NEW-3 family)", () => {
    // A decorator expression evaluates in the ENCLOSING scope too — not the
    // decorated method's param scope. `@db.deco` is a genuine outside use.
    const src = `${IMPORTS}
export default live("/d")
  .setup(() => ({ n: 0 }))
  .load(async (_u) => { await db.query(); })
  .render(() => { class C { @db.deco run(db: unknown) { return db; } } return C; });
`;
    const code = (stripLiveModule(src, "d.tsx") as { code: string }).code;
    expect(code).toContain("import { db }"); // decorator = real enclosing-scope use
    expect(code).toContain('from "./db"');
    expect(parsesClean(code)).toBe(true);
  });
});

/**
 * Transform-hook gating: only client (`!ssr`) builds of registered live modules
 * (routes-dir pages OR scanned live modules) are transformed; SSR, non-source,
 * and non-live ids pass through untouched.
 */
describe("rpxd() transform hook — gating", () => {
  const root = "/app";
  // biome-ignore lint/suspicious/noExplicitAny: exercising the plugin hook directly in a unit test
  const plugin = rpxd() as any;
  plugin.configResolved({ root });
  const transform = (code: string, id: string, ssr: boolean) =>
    plugin.transform.call({}, code, id, { ssr });

  const liveSrc = `import { live } from "@rpxd/core";
export default live("/x").setup(() => ({})).load(async () => {}).render(() => null);`;

  it("transforms a scanned live module on the client build", () => {
    const r = transform(liveSrc, "/app/src/chat.tsx", false);
    expect(r).toBeTruthy();
    expect(r.code).toContain("__rpxdServerStub");
  });

  it("transforms a routes-dir page on the client build", () => {
    const r = transform(liveSrc, "/app/routes/board.tsx", false);
    expect(r).toBeTruthy();
    expect(r.code).toContain("__rpxdServerStub");
  });

  it("leaves the SSR build untouched", () => {
    expect(transform(liveSrc, "/app/src/chat.tsx", true)).toBeNull();
  });

  it("leaves non-live and non-source ids untouched", () => {
    expect(transform(`export const x = 1;`, "/app/src/util.ts", false)).toBeNull();
    expect(transform(`.foo{}`, "/app/src/styles.css", false)).toBeNull();
    expect(transform(liveSrc, "/app/node_modules/pkg/i.tsx", false)).toBeNull();
  });

  it("ignores query suffixes when classifying the id", () => {
    const r = transform(liveSrc, "/app/src/chat.tsx?v=123", false);
    expect(r).toBeTruthy();
  });
});

/**
 * Registration/strip parity (ADR 0002 item 5, review R1 finding 5): the strip
 * transform's scan opts must carry the user's `exclude`/`include` so the set of
 * modules registered as slots and the set stripped for the client are computed
 * identically. A user `include` that re-reaches a default-excluded live module
 * (e.g. under `**​/test/**`) registers/serves it as a slot — so it MUST also be
 * stripped, or server-only bodies + their imports leak into the client bundle.
 */
describe("rpxd() transform hook — include/exclude parity with registration", () => {
  const root = "/app";
  const liveSrc = `import { live } from "@rpxd/core";
export default live("/w").setup(() => ({})).load(async () => {}).render(() => null);`;
  const call = (plugin: unknown, id: string) =>
    // biome-ignore lint/suspicious/noExplicitAny: exercising the plugin hook directly
    (plugin as any).transform.call({}, liveSrc, id, { ssr: false });

  it("strips a live module an `include` re-reaches under a default-excluded path", () => {
    // biome-ignore lint/suspicious/noExplicitAny: exercising the plugin hook directly
    const plugin = rpxd({ include: ["**/test/**"] }) as any;
    plugin.configResolved({ root });
    const r = call(plugin, "/app/src/test/widget.tsx");
    expect(r).toBeTruthy(); // registered as a slot ⇒ must be stripped too
    expect(r.code).toContain("__rpxdServerStub");
  });

  it("without the include, the same default-excluded module is left untouched", () => {
    // biome-ignore lint/suspicious/noExplicitAny: exercising the plugin hook directly
    const plugin = rpxd() as any;
    plugin.configResolved({ root });
    expect(call(plugin, "/app/src/test/widget.tsx")).toBeNull();
  });

  it("honors a user `exclude` that drops an otherwise-registered module from the strip", () => {
    // biome-ignore lint/suspicious/noExplicitAny: exercising the plugin hook directly
    const plugin = rpxd({ exclude: ["**/vendor/**"] }) as any;
    plugin.configResolved({ root });
    expect(call(plugin, "/app/src/vendor/widget.tsx")).toBeNull();
  });
});
