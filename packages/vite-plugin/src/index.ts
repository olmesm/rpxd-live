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
  generateLiveModule,
  generateRoutesModule,
  scanRoutes,
} from "./codegen.ts";
import { fileToRoute, type RouteEntry } from "./routes.ts";
import { isLiveScanCandidate, type LiveModuleEntry, scanLiveModules } from "./scan.ts";
import { stripLiveModule } from "./strip.ts";

export {
  ensurePathLiteral,
  generateHandlersModule,
  generateLiveModule,
  generateRoutesModule,
  scanRoutes,
} from "./codegen.ts";
export { fileToRoute, pathToPattern, type RouteEntry, sortRoutes } from "./routes.ts";
export {
  DEFAULT_LIVE_EXCLUDES,
  findLiveCalls,
  findPatternLiteral,
  isLiveScanCandidate,
  type LiveModuleEntry,
  LiveScanError,
  type PatternLiteral,
  type ScanLiveOptions,
  scanLiveModules,
} from "./scan.ts";
export { type StripResult, stripLiveModule } from "./strip.ts";

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
  /**
   * Extra glob patterns excluded from the `live()` scan (ADR 0002 item 4),
   * concatenated with {@link DEFAULT_LIVE_EXCLUDES}. The routes and output dirs
   * are always excluded structurally.
   */
  exclude?: string[];
  /**
   * Glob patterns that re-include a file an `exclude` glob would drop from the
   * `live()` scan. Structural prunes (node_modules, hidden dirs, the routes/out
   * dirs) are not reachable.
   */
  include?: string[];
}

/**
 * Assert a module loaded from `live.gen.ts` default-exports a `live()` object
 * (`$live: true`) — the boot-time backstop for the syntactic scan (ADR 0002
 * item 4). A scan false-positive fails here at startup, not at first mount.
 * Returns the live object for registration.
 *
 * @example
 * ```ts
 * const route = assertLiveModule(await liveModules["/chat"](), "/chat");
 * routes.push({ path: "/chat", def: route.def, props: route.props });
 * ```
 */
export function assertLiveModule(
  mod: unknown,
  pattern: string,
): { $live: true; path: string; def: unknown; props?: unknown } {
  const def = (mod as { default?: { $live?: unknown } }).default;
  if (def?.$live !== true) {
    throw new Error(
      `live.gen: module registered for pattern ${JSON.stringify(pattern)} does not default-export a live() object ($live !== true)`,
    );
  }
  return def as { $live: true; path: string; def: unknown; props?: unknown };
}

/**
 * Compose the routes-dir registrations with the scanned `live()` modules and
 * reject a pattern claimed by both (ADR 0002 Decision 2 — pattern uniqueness
 * across the union is the load-bearing invariant). Throws naming both files.
 */
function assertNoUnionConflicts(
  root: string,
  routeEntries: RouteEntry[],
  liveEntries: LiveModuleEntry[],
): void {
  const pageByPath = new Map<string, string>();
  for (const e of routeEntries) {
    if (e.kind === "page" && e.path !== null) pageByPath.set(e.path, e.file);
  }
  const conflicts: string[] = [];
  for (const le of liveEntries) {
    const routeFile = pageByPath.get(le.path);
    if (routeFile) {
      conflicts.push(
        `  - pattern ${JSON.stringify(le.path)} declared in both routes/${routeFile} and ${le.file}`,
      );
    }
  }
  if (conflicts.length > 0) {
    throw new Error(
      `rpxd: duplicate live() pattern across routes and scanned modules (${root}):\n${conflicts.join("\n")}`,
    );
  }
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

  // Discover exported live() objects outside the routes dir (ADR 0002 item 4)
  // and reject any pattern claimed by both tables — union uniqueness is the
  // load-bearing invariant (Decision 2).
  const liveEntries = scanLiveModules(root, {
    routesDir,
    outDir,
    exclude: options.exclude,
    include: options.include,
  });
  assertNoUnionConflicts(root, entries, liveEntries);

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
  // Server-only live()-mount map (ADR 0002 item 4) — the control-plane union.
  write("live.gen.ts", generateLiveModule(liveEntries));
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
    /**
     * Client-build strip (ADR 0002 item 5): on the **client** graph only
     * (`!ssr`), stub server-only chain steps of every registered `live()`
     * module — routes-dir pages *and* scanned live modules — and prune the
     * imports only they used. The SSR/server graph keeps the real handlers, so
     * dev and prod share one code path (dev has no build-time treeshake, so the
     * transform prunes imports itself). Non-live and non-source ids pass through.
     */
    transform(code, id, transformOptions) {
      if (transformOptions?.ssr) return null; // server graph keeps real handlers
      const file = id.split("?", 1)[0] as string; // drop Vite query suffixes
      if (!/\.[cm]?[jt]sx?$/.test(file)) return null; // source modules only
      const routesDir = resolve(root, routesDirName);
      const scanOpts = { routesDir, outDir: resolve(root, options.outDir ?? ".rpxd") };
      // Union of both registration tables: routes-dir pages (excluded from the
      // scan structurally) and scanned live modules anywhere else.
      const registered =
        isRouteFilePath(file, routesDir) || isLiveScanCandidate(file, root, scanOpts);
      if (!registered) return null;
      if (!code.includes("live")) return null; // cheap pre-check before the AST confirm
      return stripLiveModule(code, file);
    },
    configureServer(server) {
      const routesDir = resolve(root, routesDirName);
      const outDir = resolve(root, options.outDir ?? ".rpxd");
      runCodegen(root, options);
      // Watch the routes dir and the wider project tree: an exported live()
      // object can live anywhere outside routes (ADR 0002 item 4).
      server.watcher.add(routesDir);
      server.watcher.add(root);

      const scanOpts = { routesDir, outDir, exclude: options.exclude, include: options.include };
      const onFileEvent = (file: string) => {
        // Re-run codegen only for route files or live-scan candidates —
        // .rpxd writes, assets, and node_modules never trigger a re-scan.
        if (!isRouteFilePath(file, routesDir) && !isLiveScanCandidate(file, root, scanOpts)) return;
        try {
          runCodegen(root, options);
        } catch (err) {
          // A mid-edit scan violation (unexported/duplicate live()) must not
          // crash the dev watcher — surface it and wait for the next save.
          console.error(`[rpxd] codegen failed:\n${(err as Error).message}`);
        }
      };
      server.watcher.on("add", onFileEvent);
      server.watcher.on("unlink", onFileEvent);
      server.watcher.on("change", onFileEvent);
    },
  };
}
