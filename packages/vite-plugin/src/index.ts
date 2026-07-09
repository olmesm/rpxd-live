/**
 * rpxd Vite plugin (§14): route codegen + path-literal maintenance.
 * (Reducer HMR and RSC wiring live in the CLI dev server, not this plugin.)
 *
 * @packageDocumentation
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve, sep } from "node:path";
import type { Plugin } from "vite";
import {
  ensurePathLiteral,
  generateHandlersModule,
  generateRoutesModule,
  scanRoutes,
} from "./codegen.ts";
import { fileToRoute } from "./routes.ts";

export {
  ensurePathLiteral,
  generateHandlersModule,
  generateRoutesModule,
  scanRoutes,
} from "./codegen.ts";
export { fileToRoute, pathToPattern, type RouteEntry, sortRoutes } from "./routes.ts";

/**
 * Whether a watcher file event refers to a route file inside `routesDir`. The
 * containment check uses a path-separator boundary so a sibling directory that
 * merely shares the prefix (`routes-backup/`) does not match `routes/`.
 *
 * @example
 * ```ts
 * isRouteFilePath("/app/routes/index.tsx", "/app/routes"); // true
 * isRouteFilePath("/app/routes-backup/index.tsx", "/app/routes"); // false
 * ```
 */
export function isRouteFilePath(file: string, routesDir: string): boolean {
  const abs = resolve(file);
  const within = abs === routesDir || abs.startsWith(routesDir + sep);
  return within && fileToRoute(basename(file)) !== null;
}

/** Options for {@link rpxd} and {@link runCodegen}. */
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
 *
 * @example
 * ```ts
 * runCodegen("/path/to/app"); // writes /path/to/app/.rpxd/routes.gen.ts
 * ```
 */
export function runCodegen(root: string, options: RpxdPluginOptions = {}): string {
  const routesDir = resolve(root, options.routesDir ?? "routes");
  const outDir = resolve(root, options.outDir ?? ".rpxd");
  const entries = existsSync(routesDir) ? scanRoutes(routesDir) : [];

  // Maintain path literals: rename → rewritten; hand-edit → corrected (§7).
  // Both live() pages and route() HTTP files carry a maintained literal.
  for (const entry of entries) {
    if ((entry.kind !== "page" && entry.kind !== "http") || entry.path === null) continue;
    const file = join(routesDir, entry.file);
    const source = readFileSync(file, "utf-8");
    const fixed = ensurePathLiteral(source, entry.path);
    if (fixed !== null) writeFileSync(file, fixed);
  }

  mkdirSync(outDir, { recursive: true });
  const write = (name: string, content: string) => {
    const file = join(outDir, name);
    const previous = existsSync(file) ? readFileSync(file, "utf-8") : "";
    if (previous !== content) writeFileSync(file, content);
  };

  const generated = generateRoutesModule(entries);
  write("routes.gen.ts", generated);
  // Server-only HTTP route map — separate file so the client entry never
  // imports it (see the routes & auth guide).
  write("handlers.gen.ts", generateHandlersModule(entries));
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

      const onFileEvent = (file: string) => {
        if (isRouteFilePath(file, routesDir)) runCodegen(root, options);
      };
      server.watcher.on("add", onFileEvent);
      server.watcher.on("unlink", onFileEvent);
      server.watcher.on("change", onFileEvent);
    },
  };
}
