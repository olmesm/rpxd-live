#!/usr/bin/env bun
/**
 * The `rpxd` CLI (§14). Two families of commands, one dispatcher (citty):
 *
 * - **Run**: `dev` (Vite middleware + rpxd runtime, one port), `build` (client
 *   + server bundles), `start` (pure-Bun runtime over the build). All accept
 *   `--transport <sse|ws>` and `--rsc` / `--no-rsc` to override `rpxd.config.ts`.
 * - **Generate**: `init` (new app), `auth` (add Better Auth), `scaffold` (a
 *   resource). File scaffolders — they write files and *print* the rest
 *   (config edits, deps), never patching hand-owned files.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { defineCommand, runMain } from "citty";
import { consola } from "consola";
import type { ConfigOverrides } from "./config.ts";
import { planAuth } from "./generators/auth.ts";
import { detectFeatures } from "./generators/detect.ts";
import { planInit } from "./generators/init.ts";
import { runPlan } from "./generators/run.ts";
import { planScaffold } from "./generators/scaffold.ts";

/** Parse the shared `--transport` / `--rsc` run flags into config overrides. */
function overridesFrom(args: { transport?: string; rsc?: boolean }): ConfigOverrides {
  const overrides: ConfigOverrides = {};
  if (args.transport !== undefined) {
    if (args.transport !== "sse" && args.transport !== "ws") {
      consola.error(`--transport must be "sse" or "ws" (got "${args.transport}")`);
      process.exit(1);
    }
    overrides.transport = args.transport;
  }
  if (typeof args.rsc === "boolean") overrides.rsc = args.rsc;
  return overrides;
}

/** Config-override flags shared by dev/build/start. */
const runArgs = {
  transport: { type: "string", description: "Override transport: sse or ws" },
  rsc: { type: "boolean", description: "Force RSC fields on (--rsc) or off (--no-rsc)" },
} as const;

/** dev/start also bind a port. */
const serveArgs = {
  ...runArgs,
  port: { type: "string", description: "Port to bind (default: $PORT, else 3000)" },
} as const;

/** Resolve the bind port: `--port` flag wins, then `$PORT`, then 3000. */
function resolvePort(args: { port?: string }): number {
  const raw = args.port ?? process.env.PORT;
  if (raw === undefined) return 3000;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    consola.error(`--port must be an integer 0–65535 (got "${raw}")`);
    process.exit(1);
  }
  return port;
}

/** Our own version for the banner; `undefined` if the read ever fails. */
function cliVersion(): string | undefined {
  try {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf-8"));
    return typeof pkg.version === "string" ? pkg.version : undefined;
  } catch {
    return undefined;
  }
}

async function runDev(port: number, overrides: ConfigOverrides): Promise<void> {
  const [{ createDevServer }, { startBanner }] = await Promise.all([
    import("./dev-server.ts"),
    import("./banner.ts"),
  ]);
  // The roll-in plays *while* the server boots — it covers the wait instead
  // of adding to it; finish() joins both and prints the summary.
  const banner = startBanner({ command: "dev" });
  const t0 = performance.now();
  try {
    const server = await createDevServer(process.cwd(), { port, overrides });
    await banner.finish({
      port: server.port,
      version: cliVersion(),
      readyMs: performance.now() - t0,
      ...server.info,
    });
  } catch (error) {
    await banner.abort();
    throw error;
  }
}

const dev = defineCommand({
  meta: {
    name: "dev",
    description: "Start the dev server (Vite + rpxd runtime). BORING=me skips the banner",
  },
  args: serveArgs,
  run: ({ args }) => runDev(resolvePort(args), overridesFrom(args)),
});

const build = defineCommand({
  meta: { name: "build", description: "Build the client + server bundles" },
  args: runArgs,
  run: async ({ args }) => {
    const { buildApp } = await import("./build.ts");
    await buildApp(process.cwd(), overridesFrom(args));
    consola.success("rpxd build → dist/client + dist/server");
  },
});

const start = defineCommand({
  meta: { name: "start", description: "Serve the build from pure Bun (no Vite)" },
  args: serveArgs,
  run: async ({ args }) => {
    const [{ startApp }, { startBanner }, { installShutdownHandlers }] = await Promise.all([
      import("./start.ts"),
      import("./banner.ts"),
      import("./shutdown.ts"),
    ]);
    // Prod gets the settled frame, no animation; same BORING escape hatch.
    const banner = startBanner({ command: "start" });
    const t0 = performance.now();
    const app = await startApp(process.cwd(), {
      port: resolvePort(args),
      overrides: overridesFrom(args),
    });
    // Flush warm snapshots + run cleanup on SIGTERM/SIGINT (containers, Ctrl-C).
    installShutdownHandlers(app.close);
    await banner.finish({
      port: app.port,
      version: cliVersion(),
      readyMs: performance.now() - t0,
      ...app.info,
    });
  },
});

const init = defineCommand({
  meta: { name: "init", description: "Scaffold a new rpxd app" },
  args: {
    dir: { type: "positional", required: false, description: "Target directory (default: .)" },
    auth: { type: "boolean", default: true, description: "Wire Better Auth (--no-auth to skip)" },
    db: { type: "boolean", default: true, description: "Wire Prisma/SQLite (--no-db to skip)" },
    force: { type: "boolean", default: false, description: "Write into a non-empty directory" },
  },
  run: ({ args }) => {
    const root = resolve(args.dir ?? ".");
    const nonEmpty =
      existsSync(root) &&
      readdirSync(root).some((e) => e !== ".git" && e !== "node_modules" && !e.startsWith("."));
    if (nonEmpty && !args.force) {
      consola.error(`${root} is not empty — pass --force to scaffold into it anyway.`);
      process.exit(1);
    }
    const plan = planInit({ name: basename(root), auth: args.auth, db: args.db });
    consola.start(`Scaffolding ${basename(root)} (auth=${args.db && args.auth}, db=${args.db})`);
    runPlan(root, plan, { force: args.force, codegen: true });
    consola.success(`Created ${basename(root)}.`);
  },
});

const auth = defineCommand({
  meta: { name: "auth", description: "Add Better Auth + Prisma to an existing app" },
  args: {
    force: { type: "boolean", default: false, description: "Overwrite existing files" },
  },
  run: ({ args }) => {
    const root = process.cwd();
    const plan = planAuth({ features: detectFeatures(root) });
    runPlan(root, plan, { force: args.force, codegen: true });
    consola.success("Auth files written. Follow the steps above to finish wiring.");
  },
});

const scaffold = defineCommand({
  meta: {
    name: "scaffold",
    description: "Generate a resource: rpxd scaffold <Context> <Schema> <plural> [field:type…]",
  },
  args: {
    context: { type: "positional", required: true, description: "Context module, e.g. Todos" },
    schema: { type: "positional", required: true, description: "Schema (singular), e.g. Todo" },
    plural: { type: "positional", required: true, description: "Plural route/table, e.g. todos" },
    kind: { type: "string", default: "page", description: "page (live route) or http (route())" },
    protected: {
      type: "boolean",
      description:
        "Protect the page (default: on when the app has auth; --no-protected to opt out)",
    },
    test: { type: "boolean", default: true, description: "Emit a domain test (--no-test to skip)" },
    force: { type: "boolean", default: false, description: "Overwrite existing files" },
  },
  run: ({ args }) => {
    if (args.kind !== "page" && args.kind !== "http") {
      consola.error(`--kind must be "page" or "http" (got "${args.kind}")`);
      process.exit(1);
    }
    const fieldSpecs = (args._ as string[]).slice(3);
    const root = process.cwd();
    try {
      const plan = planScaffold({
        context: args.context,
        schema: args.schema,
        plural: args.plural,
        fieldSpecs,
        kind: args.kind,
        protectedRoute: args.protected,
        test: args.test,
        features: detectFeatures(root),
      });
      runPlan(root, plan, { force: args.force, codegen: true });
      consola.success(`Scaffolded ${args.schema}.`);
    } catch (error) {
      consola.error((error as Error).message);
      process.exit(1);
    }
  },
});

const main = defineCommand({
  meta: { name: "rpxd", description: "Live objects for React — dev server + generators" },
  // Bare `rpxd` prints usage; `rpxd dev` (etc.) run the commands below.
  subCommands: { dev, build, start, init, auth, scaffold },
});

runMain(main);
