#!/usr/bin/env bun
/**
 * `rpxd dev|build|start` (§14).
 *
 * - `dev`: one Bun process, Vite middleware mode + rpxd runtime, one port.
 * - `build`: production client + server (+ rsc) bundles.
 * - `start`: pure Bun runtime over the build.
 *
 * Flags (all commands): `--transport <sse|ws>` and `--rsc` / `--no-rsc`
 * override `rpxd.config.ts` — handy for exercising one app across the
 * render/transport combinations (the CI matrix) without editing the config.
 */
import type { ConfigOverrides } from "./config.ts";
import { createDevServer } from "./dev-server.ts";

const argv = process.argv.slice(2);
const [command = "dev"] = argv;

/** Parse `--transport <sse|ws>`, `--rsc`, `--no-rsc` into config overrides. */
function parseOverrides(args: string[]): ConfigOverrides {
  const overrides: ConfigOverrides = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--transport") {
      const value = args[++i];
      if (value !== "sse" && value !== "ws") {
        console.error(`--transport must be "sse" or "ws" (got "${value ?? ""}")`);
        process.exit(1);
      }
      overrides.transport = value;
    } else if (arg === "--rsc") {
      overrides.rsc = true;
    } else if (arg === "--no-rsc") {
      overrides.rsc = false;
    }
  }
  return overrides;
}

const overrides = parseOverrides(argv.slice(1));

switch (command) {
  case "dev": {
    const port = Number(process.env.PORT ?? 3000);
    const server = await createDevServer(process.cwd(), { port, overrides });
    console.log(`rpxd dev → http://localhost:${server.port}`);
    break;
  }
  case "build": {
    const { buildApp } = await import("./build.ts");
    await buildApp(process.cwd(), overrides);
    console.log("rpxd build → dist/client + dist/server");
    break;
  }
  case "start": {
    const { startApp } = await import("./start.ts");
    const port = Number(process.env.PORT ?? 3000);
    const app = await startApp(process.cwd(), { port, overrides });
    console.log(`rpxd start → http://localhost:${app.port}`);
    break;
  }
  default:
    console.error(
      `Unknown command "${command}". Usage: rpxd dev|build|start [--transport sse|ws] [--rsc|--no-rsc]`,
    );
    process.exit(1);
}
