/**
 * `rpxd build` (§14): `vite build` twice — client bundle (hashed assets +
 * manifest) and SSR bundle (route modules for the pure-Bun `rpxd start`).
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { rpxd as rpxdVitePlugin, runCodegen } from "@rpxd/vite-plugin";
import type { Plugin } from "vite";
import { build } from "vite";
import type { RpxdConfig } from "./config.ts";
import { CLIENT_ENTRY_URL, rpxdEntryPlugin } from "./entry.ts";

/** Virtual SSR entry: re-exports the generated route map for `rpxd start`. */
export const SERVER_ENTRY_URL = "/@rpxd-entry-server.ts";
const SERVER_VIRTUAL_ID = "\0rpxd-entry-server.ts";

function rpxdServerEntryPlugin(): Plugin {
  return {
    name: "rpxd-server-entry",
    resolveId(id) {
      if (id === SERVER_ENTRY_URL) return SERVER_VIRTUAL_ID;
      return undefined;
    },
    load(id) {
      if (id === SERVER_VIRTUAL_ID) {
        return `export { routeTree, routeModules, rootModule, notFoundModule, errorModule } from "/.rpxd/routes.gen.ts";`;
      }
      return undefined;
    },
  };
}

/**
 * Build an rpxd app for production: `dist/client` (assets + manifest) and
 * `dist/server/entry-server.js` (route modules).
 *
 * @example
 * ```ts
 * await buildApp(process.cwd());
 * ```
 */
export async function buildApp(root: string): Promise<void> {
  runCodegen(root);
  const configPath = join(root, "rpxd.config.ts");
  const config: RpxdConfig = existsSync(configPath)
    ? ((await import(pathToFileURL(configPath).href)).default ?? {})
    : {};

  await build({
    root,
    logLevel: "error",
    plugins: [
      rpxdVitePlugin(),
      rpxdEntryPlugin({ rsc: config.rsc, transport: config.transport?.kind }),
    ],
    build: {
      outDir: "dist/client",
      manifest: true,
      emptyOutDir: true,
      rollupOptions: { input: CLIENT_ENTRY_URL },
    },
  });

  await build({
    root,
    logLevel: "error",
    plugins: [rpxdVitePlugin(), rpxdServerEntryPlugin()],
    build: {
      ssr: true,
      outDir: "dist/server",
      emptyOutDir: true,
      rollupOptions: {
        input: { "entry-server": SERVER_ENTRY_URL },
      },
    },
  });
}
