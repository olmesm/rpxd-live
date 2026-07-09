/**
 * TDD acceptance for the generators (§14): `rpxd init` + `rpxd scaffold`
 * produce an app that typechecks, builds, boots on pure Bun, and serves both
 * the welcome route and the scaffolded resource. Runs the memory (`--no-db`)
 * path so it's deterministic with no database.
 *
 * The generated app resolves `@rpxd/*` / react / vite by symlinking the todos
 * example's `node_modules` — the same shape a real `bun install` would produce
 * (the example is a superset of a generated app's deps).
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { applyPlan } from "../src/generators/apply.ts";
import { detectFeatures } from "../src/generators/detect.ts";
import { planInit } from "../src/generators/init.ts";
import { planScaffold } from "../src/generators/scaffold.ts";
import { buildApp, type StartedApp, startApp } from "../src/index.ts";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const appRoot = join(repoRoot, ".rpxd-gen-test");
const todosModules = join(repoRoot, "examples/kitchen-sink/node_modules");
const COOKIE = "rpxd_sid=gen-test";
let app: StartedApp;

beforeAll(async () => {
  rmSync(appRoot, { recursive: true, force: true });
  mkdirSync(appRoot, { recursive: true });

  // init (memory) → scaffold a resource → route codegen, via the real plans.
  const { runCodegen } = await import("@rpxd/vite-plugin");
  applyPlan(appRoot, planInit({ name: "gen-test", auth: false, db: false }), {});
  applyPlan(
    appRoot,
    planScaffold({
      context: "Todos",
      schema: "Todo",
      plural: "todos",
      fieldSpecs: ["text:string", "done:boolean"],
      features: detectFeatures(appRoot),
    }),
    {},
  );
  runCodegen(appRoot);

  // Resolve deps like an installed app.
  symlinkSync(todosModules, join(appRoot, "node_modules"));

  await buildApp(appRoot);
  app = await startApp(appRoot, { port: 0 });
}, 120_000);

afterAll(async () => {
  await app?.close();
  rmSync(appRoot, { recursive: true, force: true });
});

describe("generated app: files", () => {
  it("scaffolds the shell + the resource", () => {
    for (const path of [
      "package.json",
      "tsconfig.json",
      "routes/index.tsx",
      "routes/todos.tsx",
      "domain/todos.ts",
      "domain/scope.ts",
    ]) {
      expect(existsSync(join(appRoot, path))).toBe(true);
    }
  });

  it("registers the scaffolded route in codegen", async () => {
    const gen = await Bun.file(join(appRoot, ".rpxd/routes.gen.ts")).text();
    expect(gen).toContain('"/todos"');
  });
});

describe("generated app: typecheck", () => {
  it("passes tsc --noEmit", async () => {
    const proc = Bun.spawn(["bunx", "tsc", "--noEmit", "-p", "tsconfig.json"], {
      cwd: appRoot,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, err, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (code !== 0) console.error(out + err);
    expect(code).toBe(0);
  }, 120_000);
});

describe("generated app: build + serve (pure Bun)", () => {
  const base = () => `http://localhost:${app.port}`;

  it("emits client + server bundles", () => {
    expect(existsSync(join(appRoot, "dist/client/.vite/manifest.json"))).toBe(true);
    expect(existsSync(join(appRoot, "dist/server/entry-server.js"))).toBe(true);
  });

  it("SSRs the welcome route", async () => {
    const res = await fetch(`${base()}/`, { headers: { cookie: COOKIE } });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("<h1>rpxd</h1>");
    expect(html).toContain('data-testid="count"');
  });

  it("SSRs the scaffolded resource route", async () => {
    const res = await fetch(`${base()}/todos`, { headers: { cookie: COOKIE } });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('data-testid="todos"');
    expect(html).toContain('data-testid="create-form"');
  });

  it("404s an unknown path", async () => {
    const res = await fetch(`${base()}/nope`, { headers: { cookie: COOKIE } });
    expect(res.status).toBe(404);
  });
});

describe("generated app: domain logic", () => {
  it("the in-memory domain creates, lists, and scopes rows", async () => {
    interface Row {
      id: string;
      text: string;
      done: boolean;
    }
    interface Domain {
      createTodo(scope: { sid: string }, input: { text: string; done: boolean }): Promise<Row>;
      listTodos(scope: { sid: string }): Promise<Row[]>;
      removeTodo(scope: { sid: string }, id: string): Promise<void>;
    }
    const d = (await import(join(appRoot, "domain/todos.ts"))) as unknown as Domain;
    const scope = { sid: "unit-a" };
    const other = { sid: "unit-b" };
    const row = await d.createTodo(scope, { text: "hi", done: false });
    expect(row.id).toBeTruthy();
    expect(await d.listTodos(scope)).toHaveLength(1);
    expect(await d.listTodos(other)).toHaveLength(0);
    await d.removeTodo(scope, row.id);
    expect(await d.listTodos(scope)).toHaveLength(0);
  });
});
