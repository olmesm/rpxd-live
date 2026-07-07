#!/usr/bin/env bun
/**
 * `rpxd dev|build|start` (§14).
 *
 * - `dev`: one Bun process, Vite middleware mode + rpxd runtime, one port.
 * - `build`/`start`: land with the production-build step (tracked in the
 *   build-order task list); `dev` is the tracer-bullet path.
 */
import { createDevServer } from "./dev-server.ts";

const [command = "dev"] = process.argv.slice(2);

switch (command) {
  case "dev": {
    const port = Number(process.env.PORT ?? 3000);
    const server = await createDevServer(process.cwd(), { port });
    console.log(`rpxd dev → http://localhost:${server.port}`);
    break;
  }
  case "build":
  case "start":
    console.error(`rpxd ${command}: not implemented yet — coming with the production build step`);
    process.exit(1);
    break;
  default:
    console.error(`Unknown command "${command}". Usage: rpxd dev|build|start`);
    process.exit(1);
}
