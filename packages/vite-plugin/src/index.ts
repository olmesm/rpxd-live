/**
 * rpxd Vite plugin (§14): route codegen + path-literal maintenance.
 * (Reducer HMR and RSC wiring arrive with the dev server / RSC steps.)
 *
 * @packageDocumentation
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import type { Plugin } from "vite";
import { ensurePathLiteral, generateRoutesModule, scanRoutes } from "./codegen.ts";
import { fileToRoute } from "./routes.ts";

export {
  ensurePathLiteral,
  generateRoutesModule,
  scanRoutes,
} from "./codegen.ts";
export { fileToRoute, pathToPattern, type RouteEntry, sortRoutes } from "./routes.ts";

export interface RpxdPluginOptions {
  /** Routes directory, relative to the Vite root. Default `routes`. */
  routesDir?: string;
  /** Output directory for generated files, relative to the Vite root. Default `.rpxd`. */
  outDir?: string;
}

/**
 * Run route codegen once for a project root: scans `routes/`, writes
 * `.rpxd/routes.gen.ts` (only on content change), and corrects in-file path
 * literals (filename is truth, §7).
 *
 * @returns the generated module source.
 */
export function runCodegen(root: string, options: RpxdPluginOptions = {}): string {
  const routesDir = resolve(root, options.routesDir ?? "routes");
  const outDir = resolve(root, options.outDir ?? ".rpxd");
  const entries = existsSync(routesDir) ? scanRoutes(routesDir) : [];

  // Maintain path literals: rename → rewritten; hand-edit → corrected (§7).
  for (const entry of entries) {
    if (entry.kind !== "page" || entry.path === null) continue;
    const file = join(routesDir, entry.file);
    const source = readFileSync(file, "utf-8");
    const fixed = ensurePathLiteral(source, entry.path);
    if (fixed !== null) writeFileSync(file, fixed);
  }

  const generated = generateRoutesModule(entries);
  mkdirSync(outDir, { recursive: true });
  const outFile = join(outDir, "routes.gen.ts");
  const previous = existsSync(outFile) ? readFileSync(outFile, "utf-8") : "";
  if (previous !== generated) writeFileSync(outFile, generated);
  return generated;
}

/**
 * The rpxd Vite plugin (§14). Owns route codegen (§7): scans the routes dir
 * at build start and keeps `.rpxd/routes.gen.ts` + in-file path literals in
 * sync while the dev server runs.
 *
 * @example
 * ```ts
 * // vite.config.ts
 * import { rpxd } from "@rpxd/vite-plugin";
 * export default { plugins: [rpxd()] };
 * ```
 */
export function rpxd(options: RpxdPluginOptions = {}): Plugin {
  let root = process.cwd();
  const routesDirName = options.routesDir ?? "routes";

  return {
    name: "rpxd",
    configResolved(config) {
      root = config.root;
    },
    buildStart() {
      runCodegen(root, options);
    },
    configureServer(server) {
      const routesDir = resolve(root, routesDirName);
      runCodegen(root, options);
      server.watcher.add(routesDir);

      const isRouteFile = (file: string) =>
        resolve(file).startsWith(routesDir) && fileToRoute(basename(file)) !== null;

      const onFileEvent = (file: string) => {
        if (isRouteFile(file)) runCodegen(root, options);
      };
      server.watcher.on("add", onFileEvent);
      server.watcher.on("unlink", onFileEvent);
      server.watcher.on("change", onFileEvent);
    },
  };
}
