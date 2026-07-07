/**
 * `rpxd build` (§14): client bundle (hashed assets + manifest) and server
 * bundle (route modules + the SSR runtime for the pure-Bun `rpxd start`).
 * With `rsc: true` (§16) the Flight plugin's builder orchestrates a third,
 * react-server environment carrying the route defs, and wires the
 * client-reference manifests across all three bundles.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { rpxd as rpxdVitePlugin, runCodegen } from "@rpxd/vite-plugin";
import rscFlightPlugin from "@vitejs/plugin-rsc";
import type { Plugin } from "vite";
import { build, createBuilder } from "vite";
import type { RpxdConfig } from "./config.ts";
import { CLIENT_ENTRY_URL, rpxdEntryPlugin, SSR_RUNTIME_URL } from "./entry.ts";

/** Virtual SSR entry: routes + the SSR runtime, for `rpxd start`. */
export const SERVER_ENTRY_URL = "/@rpxd-entry-server.ts";
const SERVER_VIRTUAL_ID = "\0rpxd-entry-server.ts";

/** Virtual react-server entry (§16): route defs compiled under `react-server`. */
export const RSC_ENTRY_URL = "/@rpxd-entry-rsc.ts";
const RSC_VIRTUAL_ID = "\0rpxd-entry-rsc.ts";

function rpxdServerEntryPlugin(): Plugin {
  return {
    name: "rpxd-server-entry",
    resolveId(id) {
      if (id === SERVER_ENTRY_URL) return SERVER_VIRTUAL_ID;
      if (id === RSC_ENTRY_URL) return RSC_VIRTUAL_ID;
      return undefined;
    },
    load(id) {
      if (id === SERVER_VIRTUAL_ID) {
        // The server bundle owns rendering (§12): routes + the SSR runtime.
        return [
          `export { routeTree, routeModules, rootModule, notFoundModule, errorModule } from "/.rpxd/routes.gen.ts";`,
          `export * from "${SSR_RUNTIME_URL}";`,
        ].join("\n");
      }
      if (id === RSC_VIRTUAL_ID) {
        // Same route table, react-server graph: `rsc()` in handlers can
        // Flight-serialize and 'use client' imports become references (§16).
        return `export { routeModules } from "/.rpxd/routes.gen.ts";`;
      }
      return undefined;
    },
  };
}

/**
 * Build an rpxd app for production: `dist/client` (assets + manifest) and
 * `dist/server/entry-server.js` (routes + SSR runtime); with `rsc: true`
 * additionally `dist/rsc/index.js` (react-server route defs).
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

  if (config.rsc) {
    // Three environments, one builder — the Flight plugin sequences them and
    // threads the client-reference manifests through (§16).
    const builder = await createBuilder({
      root,
      logLevel: "error",
      plugins: [
        rpxdVitePlugin(),
        rpxdEntryPlugin({ rsc: true, transport: config.transport?.kind }),
        rpxdServerEntryPlugin(),
        rscFlightPlugin({
          serverHandler: false,
          entries: { client: CLIENT_ENTRY_URL, rsc: RSC_ENTRY_URL },
        }),
      ],
      resolve: { dedupe: ["@vitejs/plugin-rsc"] },
      ssr: { noExternal: ["@rpxd/rsc"] },
      environments: {
        client: {
          build: {
            outDir: "dist/client",
            manifest: true,
            emptyOutDir: true,
            rollupOptions: { input: { index: CLIENT_ENTRY_URL } },
          },
        },
        ssr: {
          resolve: { noExternal: ["@rpxd/rsc"] },
          build: {
            outDir: "dist/server",
            emptyOutDir: true,
            rollupOptions: { input: { "entry-server": SERVER_ENTRY_URL } },
          },
        },
        rsc: {
          resolve: { noExternal: ["@rpxd/rsc"] },
          build: {
            emptyOutDir: true,
            rollupOptions: { input: { index: RSC_ENTRY_URL } },
          },
        },
      },
    });
    await builder.buildApp();
    return;
  }

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
    // rpxdEntryPlugin resolves the SSR runtime virtual for the server bundle.
    plugins: [rpxdVitePlugin(), rpxdServerEntryPlugin(), rpxdEntryPlugin()],
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
