/**
 * Discovery of exported `live()` objects by a **syntactic** TypeScript scan
 * (ADR 0002 Decision 3, item 4). One `ts.createSourceFile` per source file —
 * no `Program`, no type-checker, no module execution — resolves the default
 * export's `live(...)` call chain and reads the pattern string literal.
 *
 * This is the discovery half of the union table: routed pages come from
 * `routes.gen.ts`; every *other* exported `live()` object anywhere in the tree
 * is mount-registered here (Decision 2). The scan's literal spans also back
 * {@link ensurePathLiteral}'s AST splicing, retiring the old `PATH_CALL` regex.
 *
 * **Import aliasing is supported.** `import { live as l } from "@rpxd/core"`
 * binds `l`, and `l("/pattern")...` is discovered exactly as `live(...)` would
 * be — the local binding name is resolved from the import, never assumed.
 */
import { type Dirent, existsSync, readdirSync, readFileSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import * as ts from "typescript";

/** The module specifier a `live` binding must be imported from to count. */
const CORE_MODULE = "@rpxd/core";

/** Source extensions the scan parses. */
const SCAN_EXTS = [".ts", ".tsx", ".js", ".jsx"];

/**
 * Default exclusion globs for {@link scanLiveModules}. `node_modules`, the
 * `.rpxd` output dir, and `dist` never hold app-authored live objects; test
 * files are not shipped. Callers extend (never shrink) this list via
 * {@link ScanLiveOptions.exclude}; the routes dir is excluded structurally
 * (its files register through `routes.gen.ts`, so the union must not
 * double-register them).
 */
export const DEFAULT_LIVE_EXCLUDES: readonly string[] = [
  "**/node_modules/**",
  "**/.rpxd/**",
  "**/dist/**",
  "**/test/**",
  "**/test-bun/**",
  "**/*.test.*",
  "**/*.test-d.*",
];

/** One discovered exported `live()` module. */
export interface LiveModuleEntry {
  /** Source file path relative to the scan root, POSIX separators. */
  file: string;
  /** The `live(pattern)` literal — the URL / instance-key pattern. */
  path: string;
}

/** Options for {@link scanLiveModules} and the watcher predicate. */
export interface ScanLiveOptions {
  /**
   * Absolute path of the routes dir, excluded from the scan (its files are
   * already registered via `routes.gen.ts`; the union must not double-register).
   */
  routesDir?: string;
  /** Absolute path of the generated-output dir, excluded from the scan. */
  outDir?: string;
  /**
   * Extra exclusion globs, concatenated with {@link DEFAULT_LIVE_EXCLUDES}.
   * `**` matches any run of path segments, `*` any run within one segment.
   */
  exclude?: string[];
  /**
   * Globs that re-include a file which an exclude glob would drop. Structural
   * prunes (`node_modules`, hidden dirs, the routes/out dirs) are not reachable.
   */
  include?: string[];
}

/**
 * A build error naming the offending file(s). One is thrown (aggregating all
 * violations in a scan) when a `live()` call is unexported, its pattern is not
 * a static string literal, a module holds more than one `live()` call, or two
 * modules claim the same pattern.
 *
 * @example
 * ```ts
 * try {
 *   scanLiveModules(root);
 * } catch (e) {
 *   if (e instanceof LiveScanError) console.error(e.message); // names the file(s)
 * }
 * ```
 */
export class LiveScanError extends Error {
  /** Absolute paths of every file implicated by the aggregated violations. */
  readonly files: string[];
  constructor(message: string, files: string[]) {
    super(message);
    this.name = "LiveScanError";
    this.files = files;
  }
}

/** Convert a glob (`**`, `*`, `?`) to an anchored RegExp over POSIX paths. */
function globToRegExp(glob: string): RegExp {
  const g = glob.replace(/\\/g, "/");
  let re = "";
  for (let i = 0; i < g.length; i++) {
    const c = g[i] as string;
    if (c === "*") {
      if (g[i + 1] === "*") {
        if (g[i + 2] === "/") {
          re += "(?:.*/)?";
          i += 2;
        } else {
          re += ".*";
          i += 1;
        }
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else if ("/.+^$(){}|[]".includes(c)) {
      re += `\\${c}`;
    } else {
      re += c;
    }
  }
  return new RegExp(`^${re}$`);
}

/** Directory basenames pruned during the walk, derived from `**​/NAME/**` globs. */
function pruneDirNames(excludes: string[]): Set<string> {
  const names = new Set<string>(["node_modules"]);
  for (const g of excludes) {
    const m = /^\*\*\/([^/*]+)\/\*\*$/.exec(g);
    if (m) names.add(m[1] as string);
  }
  return names;
}

/** Depth-first pre-order visit of every descendant node. */
function forEachDescendant(node: ts.Node, fn: (n: ts.Node) => void): void {
  node.forEachChild((child) => {
    fn(child);
    forEachDescendant(child, fn);
  });
}

/** Pick the ScriptKind for a file so JSX parses without choking on `<T>`. */
function scriptKindFor(file: string): ts.ScriptKind {
  if (file.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (file.endsWith(".jsx")) return ts.ScriptKind.JSX;
  if (file.endsWith(".js")) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

/**
 * Follow an expression's leftmost call/property "spine" and report whether it
 * passes through `target`. `live("/x")({})(App)` and `live("/x").render(App)`
 * both spine down to the `live(...)` call — an object property or array element
 * holding a `live()` call does not (it is not the chain's result).
 */
function spineContains(top: ts.Node, target: ts.Node): boolean {
  let cur: ts.Node = top;
  for (;;) {
    if (cur === target) return true;
    if (
      ts.isCallExpression(cur) ||
      ts.isPropertyAccessExpression(cur) ||
      ts.isElementAccessExpression(cur) ||
      ts.isNonNullExpression(cur)
    ) {
      cur = cur.expression;
    } else if (ts.isParenthesizedExpression(cur)) {
      cur = cur.expression;
    } else {
      return false;
    }
  }
}

/** Local names bound to `@rpxd/core`'s `live` export (aliases resolved). */
function liveBindings(sf: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  for (const stmt of sf.statements) {
    if (!ts.isImportDeclaration(stmt)) continue;
    const spec = stmt.moduleSpecifier;
    if (!ts.isStringLiteral(spec) || spec.text !== CORE_MODULE) continue;
    const clause = stmt.importClause;
    const bindings = clause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    for (const el of bindings.elements) {
      const imported = el.propertyName?.text ?? el.name.text;
      if (imported === "live") names.add(el.name.text);
    }
  }
  return names;
}

/** Map top-level `const/let/var NAME = INIT` to their initializers. */
function topLevelInitializers(sf: ts.SourceFile): Map<string, ts.Expression> {
  const map = new Map<string, ts.Expression>();
  for (const stmt of sf.statements) {
    if (!ts.isVariableStatement(stmt)) continue;
    for (const decl of stmt.declarationList.declarations) {
      if (ts.isIdentifier(decl.name) && decl.initializer) {
        map.set(decl.name.text, decl.initializer);
      }
    }
  }
  return map;
}

/** Resolve an identifier through top-level `= otherIdentifier` hops (bounded). */
function resolveInitializer(
  name: string,
  inits: Map<string, ts.Expression>,
): ts.Expression | undefined {
  let cur = inits.get(name);
  for (let hops = 0; cur && ts.isIdentifier(cur) && hops < 8; hops++) {
    cur = inits.get(cur.text);
  }
  return cur;
}

/** The expressions (or identifiers) that form the module's default export. */
function defaultExportTargets(sf: ts.SourceFile): Array<ts.Expression | ts.Identifier> {
  const targets: Array<ts.Expression | ts.Identifier> = [];
  for (const stmt of sf.statements) {
    // `export default EXPR`
    if (ts.isExportAssignment(stmt) && !stmt.isExportEquals) {
      targets.push(stmt.expression);
      continue;
    }
    // `export { x as default }`
    if (ts.isExportDeclaration(stmt) && stmt.exportClause && ts.isNamedExports(stmt.exportClause)) {
      for (const el of stmt.exportClause.elements) {
        if (el.name.text === "default" && el.propertyName) {
          targets.push(el.propertyName);
        }
      }
    }
  }
  return targets;
}

type ModuleAnalysis =
  | { kind: "none" }
  | { kind: "entry"; path: string }
  | { kind: "error"; message: string };

/**
 * Syntactically analyse one source file: is it an exported `live()` module, and
 * if so what pattern does it register? Never executes the module.
 */
function analyzeModule(source: string, file: string): ModuleAnalysis {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, scriptKindFor(file));
  const locals = liveBindings(sf);
  if (locals.size === 0) return { kind: "none" }; // no `live` import — not ours

  const liveCalls: ts.CallExpression[] = [];
  forEachDescendant(sf, (n) => {
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && locals.has(n.expression.text)) {
      liveCalls.push(n);
    }
  });
  if (liveCalls.length === 0) return { kind: "none" };
  if (liveCalls.length > 1) {
    return {
      kind: "error",
      message: `${file}: more than one live() call in the same module — a module registers exactly one live object`,
    };
  }

  const call = liveCalls[0] as ts.CallExpression;
  const arg = call.arguments[0];
  if (!arg || !(ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg))) {
    return {
      kind: "error",
      message: `${file}: live() pattern must be a static string literal`,
    };
  }
  const path = arg.text;

  const inits = topLevelInitializers(sf);
  const exported = defaultExportTargets(sf).some((t) => {
    if (ts.isIdentifier(t)) {
      const init = resolveInitializer(t.text, inits);
      return init ? spineContains(init, call) : false;
    }
    return spineContains(t, call);
  });
  if (!exported) {
    return {
      kind: "error",
      message: `${file}: live object declared but not exported — it can't be registered or mounted`,
    };
  }
  return { kind: "entry", path };
}

/** Recursively collect scannable file paths under `dir`, honoring prunes. */
function collectFiles(
  dir: string,
  root: string,
  ctx: { prune: Set<string>; routesDir?: string; outDir?: string },
  out: string[],
): void {
  let dirents: Dirent[];
  try {
    dirents = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const dirent of dirents) {
    const abs = resolve(dir, dirent.name);
    if (dirent.isSymbolicLink()) continue; // never follow symlinks (loop-safe)
    if (dirent.isDirectory()) {
      if (dirent.name.startsWith(".")) continue; // hidden dirs (.rpxd, .git, …)
      if (ctx.prune.has(dirent.name)) continue;
      if (abs === ctx.routesDir || abs === ctx.outDir) continue;
      collectFiles(abs, root, ctx, out);
      continue;
    }
    if (!dirent.isFile()) continue;
    if (SCAN_EXTS.some((e) => dirent.name.endsWith(e))) out.push(abs);
  }
}

/** POSIX path of `abs` relative to `root`. */
function posixRel(root: string, abs: string): string {
  return relative(root, abs).split(sep).join("/");
}

/**
 * Whether a file event should trigger a live-module re-scan: a scannable
 * extension under `root`, outside the routes/out dirs and the exclude globs.
 * The watcher uses this so edits to non-source files never re-run codegen.
 *
 * @example
 * ```ts
 * isLiveScanCandidate("/app/src/chat.tsx", "/app", { routesDir: "/app/routes" }); // true
 * isLiveScanCandidate("/app/routes/index.tsx", "/app", { routesDir: "/app/routes" }); // false
 * ```
 */
export function isLiveScanCandidate(
  file: string,
  root: string,
  opts: ScanLiveOptions = {},
): boolean {
  const abs = resolve(file);
  if (abs !== root && !abs.startsWith(root + sep)) return false;
  if (!SCAN_EXTS.some((e) => abs.endsWith(e))) return false;
  const { routesDir, outDir } = opts;
  if (routesDir && (abs === routesDir || abs.startsWith(routesDir + sep))) return false;
  if (outDir && (abs === outDir || abs.startsWith(outDir + sep))) return false;
  const rel = posixRel(root, abs);
  const excludes = [...DEFAULT_LIVE_EXCLUDES, ...(opts.exclude ?? [])];
  if (excludes.some((g) => globToRegExp(g).test(rel))) {
    return (opts.include ?? []).some((g) => globToRegExp(g).test(rel));
  }
  return true;
}

/**
 * Scan the source tree under `root` for exported `live()` objects (item 4).
 * Syntactic only — parses each candidate with `ts.createSourceFile` and never
 * runs it. Returns entries keyed by the `live(pattern)` literal, deterministically
 * ordered. Throws {@link LiveScanError} (naming the file[s]) for an unexported
 * live object, a non-literal pattern, more than one `live()` per module, or a
 * duplicate pattern across the scanned modules.
 *
 * @example
 * ```ts
 * scanLiveModules("/app", { routesDir: "/app/routes", outDir: "/app/.rpxd" });
 * // → [{ file: "src/slots/chat.tsx", path: "/chat" }]
 * ```
 */
export function scanLiveModules(root: string, opts: ScanLiveOptions = {}): LiveModuleEntry[] {
  const rootAbs = resolve(root);
  if (!existsSync(rootAbs)) return [];
  const excludes = [...DEFAULT_LIVE_EXCLUDES, ...(opts.exclude ?? [])];
  const includes = opts.include ?? [];
  const prune = pruneDirNames(excludes);
  const routesDir = opts.routesDir ? resolve(opts.routesDir) : undefined;
  const outDir = opts.outDir ? resolve(opts.outDir) : undefined;

  const files: string[] = [];
  collectFiles(rootAbs, rootAbs, { prune, routesDir, outDir }, files);

  const entries: LiveModuleEntry[] = [];
  const errors: string[] = [];
  const errorFiles: string[] = [];
  // pattern → first file that claimed it, for intra-scan duplicate detection.
  const seen = new Map<string, string>();

  for (const abs of files.sort()) {
    const rel = posixRel(rootAbs, abs);
    if (excludes.some((g) => globToRegExp(g).test(rel))) {
      if (!includes.some((g) => globToRegExp(g).test(rel))) continue;
    }
    const analysis = analyzeModule(readFileSync(abs, "utf-8"), rel);
    if (analysis.kind === "none") continue;
    if (analysis.kind === "error") {
      errors.push(analysis.message);
      errorFiles.push(abs);
      continue;
    }
    const prior = seen.get(analysis.path);
    if (prior) {
      errors.push(
        `duplicate live() pattern ${JSON.stringify(analysis.path)} declared in both ${prior} and ${rel}`,
      );
      errorFiles.push(resolve(rootAbs, prior), abs);
      continue;
    }
    seen.set(analysis.path, rel);
    entries.push({ file: rel, path: analysis.path });
  }

  if (errors.length > 0) {
    throw new LiveScanError(
      `rpxd live() scan found ${errors.length} problem(s):\n${errors.map((e) => `  - ${e}`).join("\n")}`,
      errorFiles,
    );
  }

  return entries.sort((a, b) => a.path.localeCompare(b.path) || a.file.localeCompare(b.file));
}

/** A `live()`/`route()` pattern literal located by span, for splicing. */
export interface PatternLiteral {
  /** Offset of the opening quote in the source. */
  start: number;
  /** Offset just past the closing quote. */
  end: number;
  /** The quote character used (`"`, `'`, or a backtick). */
  quote: string;
  /** The literal's decoded value. */
  value: string;
}

/**
 * Locate the first `live("...")` / `route("...")` pattern literal by AST span
 * (item 4: retires the `PATH_CALL` regex). Returns `null` when the source has
 * no such call with a static string-literal first argument.
 *
 * @example
 * ```ts
 * findPatternLiteral('export default live("/old")({})(App);');
 * // → { start: 20, end: 26, quote: '"', value: "/old" }
 * ```
 */
export function findPatternLiteral(source: string): PatternLiteral | null {
  const sf = ts.createSourceFile(
    "__ensure.tsx",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  let best: PatternLiteral | null = null;
  forEachDescendant(sf, (n) => {
    if (!ts.isCallExpression(n) || !ts.isIdentifier(n.expression)) return;
    if (n.expression.text !== "live" && n.expression.text !== "route") return;
    const arg = n.arguments[0];
    if (!arg || !(ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg))) return;
    const start = arg.getStart(sf);
    if (best && best.start <= start) return; // keep the earliest in source order
    best = { start, end: arg.getEnd(), quote: source[start] as string, value: arg.text };
  });
  return best;
}
