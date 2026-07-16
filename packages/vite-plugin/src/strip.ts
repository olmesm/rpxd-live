/**
 * Client-build strip transform (ADR 0002 Decision 3, item 5): server-only chain
 * steps of a registered `live()` module must never reach the browser. Loader
 * bodies, guards, event/rpc handlers — and their server-only import graphs
 * (`bun:sqlite`, `node:fs`, a Prisma client) — are reachable from the client
 * bundle today; this transform severs that edge, keeping only what the client
 * genuinely runs: the pattern + props schema, rpc `input` schemas, `optimistic`
 * replay fns, and the rendered component.
 *
 * It is AST-based (same `ts.createSourceFile` settings the discovery scan uses —
 * {@link findLiveCalls} / {@link forEachDescendant}) and pure: identical source
 * text yields byte-identical output, so it is HMR-stable. Import pruning is
 * conservative — a binding is removed only when it was referenced *exclusively*
 * inside a stripped span (never a side-effect import, never a binding still used
 * by `optimistic`/`render`/the schema).
 *
 * **Why stubbing `setup` is safe.** The client builds the def (for
 * `rpcMetaFromDef`) but never invokes `setup`/`guard`/`load`/handlers — verified:
 * `packages/client` contains no `.setup`/`def.setup` call. Stubs are a named
 * `__rpxdServerStub` that throws, so a logic error that *does* reach one on the
 * client fails loud rather than silently no-op'ing.
 *
 * @packageDocumentation
 */
import MagicString from "magic-string";
import * as ts from "typescript";
import { findLiveCalls, forEachDescendant, scriptKindFor } from "./scan.ts";

/** Identifier the stripped function arguments are replaced with. */
const STUB_NAME = "__rpxdServerStub";

/** The stub's thrown message — documented so tests and reviewers can pin it. */
const STUB_MESSAGE = "rpxd: server-only code invoked on the client";

/** The injected stub declaration (hoisted; throws if ever invoked client-side). */
const STUB_DECL = `function ${STUB_NAME}() { throw new Error(${JSON.stringify(STUB_MESSAGE)}); }\n`;

/** A half-open byte range `[start, end)` of a stripped function-expression arg. */
interface Span {
  start: number;
  end: number;
}

/** The result of {@link stripLiveModule}: a Vite-compatible transform payload. */
export interface StripResult {
  /** Transformed module source. */
  code: string;
  /** Source map (magic-string, hi-res) mapping output back to the original chain. */
  map: ReturnType<MagicString["generateMap"]>;
}

/** Record `node`'s span as stripped and overwrite it with the stub identifier. */
function stripArg(node: ts.Node, sf: ts.SourceFile, ms: MagicString, spans: Span[]): void {
  const start = node.getStart(sf);
  const end = node.getEnd();
  spans.push({ start, end });
  ms.overwrite(start, end, STUB_NAME);
}

/**
 * Walk the fluent `live(...)` chain upward from the base call, stubbing the
 * server-only argument at each server-only step. `.rpc(name, r => …)` keeps its
 * name and descends into the builder arrow to stub only `.handler`/`.onError`.
 */
function stripChain(
  liveCall: ts.CallExpression,
  sf: ts.SourceFile,
  ms: MagicString,
  spans: Span[],
): void {
  let node: ts.Node = liveCall;
  for (;;) {
    const access = node.parent;
    if (!access || !ts.isPropertyAccessExpression(access) || access.expression !== node) break;
    const call = access.parent;
    if (!call || !ts.isCallExpression(call) || call.expression !== access) break;

    const method = access.name.text;
    const args = call.arguments;
    switch (method) {
      case "setup":
      case "guard":
      case "load":
        // Whole first arg (the fn — or an imported fn reference) is server-only.
        if (args[0]) stripArg(args[0], sf, ms, spans);
        break;
      case "on":
        // Keep the event-name string; stub the handler.
        if (args[1]) stripArg(args[1], sf, ms, spans);
        break;
      case "rpc": {
        // Keep the name; descend into `r => r.input().optimistic().handler().onError()`
        // and stub only the two server-only terminals.
        const builder = args[1];
        if (builder) {
          forEachDescendant(builder, (n) => {
            if (!ts.isCallExpression(n) || !ts.isPropertyAccessExpression(n.expression)) return;
            const m = n.expression.name.text;
            if ((m === "handler" || m === "onError") && n.arguments[0]) {
              stripArg(n.arguments[0], sf, ms, spans);
            }
          });
        }
        break;
      }
      // input / optimistic / rateLimit / version / render — kept verbatim.
      default:
        break;
    }
    node = call;
  }
}

/** Whether `pos` falls inside any stripped span. */
function inSpans(pos: number, spans: Span[]): boolean {
  for (const s of spans) if (pos >= s.start && pos < s.end) return true;
  return false;
}

/** True when `id` is a value reference, not a member/property *name* position. */
function isValueReference(id: ts.Identifier): boolean {
  const p = id.parent;
  if (ts.isPropertyAccessExpression(p) && p.name === id) return false; // `x.NAME`
  if (ts.isQualifiedName(p) && p.right === id) return false; // `Ns.NAME` (types)
  // Object/enum/class key positions — a *value* is elsewhere. Shorthand
  // (`{ NAME }`) is a ShorthandPropertyAssignment and is deliberately NOT
  // excluded, since there the name *is* the reference.
  if (
    (ts.isPropertyAssignment(p) ||
      ts.isEnumMember(p) ||
      ts.isPropertySignature(p) ||
      ts.isMethodDeclaration(p) ||
      ts.isPropertyDeclaration(p)) &&
    p.name === id
  ) {
    return false;
  }
  // Destructuring key: `const { NAME: local } = x` — NAME reads a property, not
  // a binding; `local` (the `.name`) is the new binding, handled elsewhere.
  if (ts.isBindingElement(p) && p.propertyName === id) return false;
  return true;
}

/**
 * Collect the local names of value (non-type-only) import bindings that could be
 * pruned. Side-effect imports (`import "./x"`) and whole `import type`
 * declarations are excluded up front — they are never removed.
 */
function collectBindingNames(sf: ts.SourceFile): string[] {
  const out: string[] = [];
  for (const stmt of sf.statements) {
    if (!ts.isImportDeclaration(stmt)) continue;
    const clause = stmt.importClause;
    if (!clause) continue; // side-effect import — never touched
    if (clause.isTypeOnly) continue; // whole `import type` — vanishes at compile
    if (clause.name) out.push(clause.name.text); // default
    const nb = clause.namedBindings;
    if (nb && ts.isNamespaceImport(nb)) out.push(nb.name.text);
    if (nb && ts.isNamedImports(nb)) {
      for (const el of nb.elements) {
        if (el.isTypeOnly) continue; // per-specifier `type` — leave alone
        out.push(el.name.text);
      }
    }
  }
  return out;
}

/** Byte ranges of every import declaration, to exclude specifier ids from counts. */
function importRanges(sf: ts.SourceFile): Span[] {
  const ranges: Span[] = [];
  for (const stmt of sf.statements) {
    if (ts.isImportDeclaration(stmt)) ranges.push({ start: stmt.getStart(sf), end: stmt.getEnd() });
  }
  return ranges;
}

/**
 * Determine which local binding names are referenced *exclusively* inside
 * stripped spans (and thus safe to prune). A name kept if it has any reference
 * outside a stripped span; pruned only if it has ≥1 reference inside a stripped
 * span and 0 outside — pre-existing unused imports (0 inside, 0 outside) are
 * left untouched.
 */
function removableNames(sf: ts.SourceFile, spans: Span[], bindingNames: string[]): Set<string> {
  const names = new Set(bindingNames);
  const inside = new Map<string, number>();
  const outside = new Map<string, number>();
  const imports = importRanges(sf);

  forEachDescendant(sf, (n) => {
    if (!ts.isIdentifier(n)) return;
    if (!names.has(n.text)) return;
    if (!isValueReference(n)) return;
    const pos = n.getStart(sf);
    if (inSpans(pos, imports)) return; // the specifier itself, not a use
    const bucket = inSpans(pos, spans) ? inside : outside;
    bucket.set(n.text, (bucket.get(n.text) ?? 0) + 1);
  });

  const removable = new Set<string>();
  for (const name of names) {
    if ((outside.get(name) ?? 0) === 0 && (inside.get(name) ?? 0) > 0) removable.add(name);
  }
  return removable;
}

/** Render one surviving named-import element, preserving alias and `type`. */
function renderSpecifier(el: ts.ImportSpecifier): string {
  const prefix = el.isTypeOnly ? "type " : "";
  return el.propertyName
    ? `${prefix}${el.propertyName.text} as ${el.name.text}`
    : `${prefix}${el.name.text}`;
}

/**
 * Apply import pruning to `ms`: rewrite declarations that lost some specifiers,
 * remove those that lost all of them. Type-only elements always survive.
 */
function pruneImports(sf: ts.SourceFile, ms: MagicString, removable: Set<string>): void {
  for (const stmt of sf.statements) {
    if (!ts.isImportDeclaration(stmt)) continue;
    const clause = stmt.importClause;
    if (!clause || clause.isTypeOnly) continue;

    const defaultSurvives = clause.name ? !removable.has(clause.name.text) : false;
    const nb = clause.namedBindings;
    const isNamespace = nb !== undefined && ts.isNamespaceImport(nb);
    const namespaceSurvives = isNamespace
      ? !removable.has((nb as ts.NamespaceImport).name.text)
      : false;

    let namedSurvivors: ts.ImportSpecifier[] = [];
    let hadNamed = false;
    if (nb && ts.isNamedImports(nb)) {
      hadNamed = true;
      namedSurvivors = nb.elements.filter((el) => el.isTypeOnly || !removable.has(el.name.text));
    }

    const removedDefault = clause.name !== undefined && !defaultSurvives;
    const removedNamespace = isNamespace && !namespaceSurvives;
    const removedNamed =
      hadNamed && namedSurvivors.length < (nb as ts.NamedImports).elements.length;
    if (!removedDefault && !removedNamespace && !removedNamed) continue; // nothing changed

    // Nothing survives → drop the whole declaration.
    const nothingSurvives =
      !defaultSurvives &&
      !(isNamespace && namespaceSurvives) &&
      !(hadNamed && namedSurvivors.length > 0);
    if (nothingSurvives) {
      ms.remove(stmt.getStart(sf), stmt.getEnd());
      continue;
    }

    // Rebuild the clause from survivors, preserving the original module quotes.
    const parts: string[] = [];
    if (defaultSurvives && clause.name) parts.push(clause.name.text);
    if (isNamespace && namespaceSurvives) {
      parts.push(`* as ${(nb as ts.NamespaceImport).name.text}`);
    } else if (hadNamed && namedSurvivors.length > 0) {
      parts.push(`{ ${namedSurvivors.map(renderSpecifier).join(", ")} }`);
    }
    const moduleText = stmt.moduleSpecifier.getText(sf);
    ms.overwrite(
      stmt.getStart(sf),
      stmt.getEnd(),
      `import ${parts.join(", ")} from ${moduleText};`,
    );
  }
}

/**
 * Strip server-only chain steps from a registered `live()` module for the client
 * build, then prune imports orphaned by the strip. Returns a `{ code, map }`
 * transform payload, or `null` when `source` is not an exported `live()` module
 * (no `@rpxd/core` `live` import/call, or an ambiguous multi-`live()` module the
 * discovery scan already rejects) — in which case the caller returns the source
 * unchanged.
 *
 * @example
 * ```ts
 * const out = stripLiveModule(source, "src/report.tsx");
 * if (out) return out; // { code, map } — server-only steps gone, input/optimistic kept
 * ```
 */
export function stripLiveModule(source: string, fileName: string): StripResult | null {
  const sf = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    scriptKindFor(fileName),
  );
  const liveCalls = findLiveCalls(sf);
  // 0 → not a live module; >1 → ambiguous (a build error the scan reports).
  if (liveCalls.length !== 1) return null;

  const ms = new MagicString(source);
  const spans: Span[] = [];
  stripChain(liveCalls[0] as ts.CallExpression, sf, ms, spans);
  if (spans.length === 0) return null; // a bare live() with no chain — nothing server-only

  const bindingNames = collectBindingNames(sf);
  const removable = removableNames(sf, spans, bindingNames);
  pruneImports(sf, ms, removable);

  ms.prepend(STUB_DECL);
  return {
    code: ms.toString(),
    map: ms.generateMap({ source: fileName, hires: true, includeContent: true }),
  };
}
