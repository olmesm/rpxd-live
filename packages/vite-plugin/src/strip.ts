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
 * by `optimistic`/`render`/the schema). Reference counting is **scope-aware**:
 * each identifier is resolved to its lexical binding, so a kept step declaring a
 * local that shadows an import name (`import { db }` used only in `.load`, while
 * `.render` has its own `const db`) does not keep the import alive — the shadow
 * binds locally, not to the import. The walk only discounts a reference when it
 * *confidently* resolves to a local (see {@link isShadowedLocally}); anything it
 * cannot resolve is treated as a real use, so the conservative direction holds.
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

/** Collect every name a binding pattern introduces (nested destructuring too). */
function collectBindingName(name: ts.BindingName, out: Set<string>): void {
  if (ts.isIdentifier(name)) {
    out.add(name.text);
    return;
  }
  for (const el of name.elements) {
    if (ts.isBindingElement(el)) collectBindingName(el.name, out);
  }
}

/** Whether `n` is a function-like node with its own parameter scope. */
function isFunctionScope(
  n: ts.Node,
): n is
  | ts.FunctionDeclaration
  | ts.FunctionExpression
  | ts.ArrowFunction
  | ts.MethodDeclaration
  | ts.ConstructorDeclaration
  | ts.GetAccessorDeclaration
  | ts.SetAccessorDeclaration {
  return (
    ts.isFunctionDeclaration(n) ||
    ts.isFunctionExpression(n) ||
    ts.isArrowFunction(n) ||
    ts.isMethodDeclaration(n) ||
    ts.isConstructorDeclaration(n) ||
    ts.isGetAccessorDeclaration(n) ||
    ts.isSetAccessorDeclaration(n)
  );
}

/**
 * Whether a reference that reached `parent` from child `from` lies within
 * `parent`'s OWN binding scope (NEW-3). A function-like member's **computed
 * name** (`[expr](…)`) and its **decorators** evaluate in the scope *enclosing*
 * the member, not in its parameter scope — so a reference reached through either
 * must NOT be attributed to the member's parameters. Missing this is a FALSE
 * shadow: `const o = { [db.key](db) { … } }` would credit the computed-name
 * `db` to the method's `db` param, prune the still-used import, and crash the
 * client. Every other position (the body, parameter initializers) is in scope.
 */
function inParentOwnScope(parent: ts.Node, from: ts.Node): boolean {
  if (ts.isDecorator(from)) return false; // decorators evaluate in the enclosing scope
  // A function-like member's computed name evaluates in the enclosing scope.
  if (isFunctionScope(parent) && from === parent.name) return false;
  return true;
}

/**
 * Whether `scope` — a single lexical scope node — *directly* introduces a value
 * binding named `name` (its own nested scopes are not consulted; the ancestor
 * walk in {@link isShadowedLocally} visits those separately). Only clear, direct
 * bindings count, so the analysis never mistakes a real import use for a shadow
 * (a false strip); missing a subtler binding (e.g. hoisted `var` in a sibling
 * block) merely keeps the import — the safe direction.
 */
function scopeIntroduces(scope: ts.Node, name: string): boolean {
  const names = new Set<string>();
  if (isFunctionScope(scope)) {
    for (const p of scope.parameters) collectBindingName(p.name, names);
    // A named function expression binds its own name inside its body.
    if (ts.isFunctionExpression(scope) && scope.name) names.add(scope.name.text);
  } else if (ts.isBlock(scope)) {
    for (const st of scope.statements) {
      if (ts.isVariableStatement(st)) {
        for (const d of st.declarationList.declarations) collectBindingName(d.name, names);
      } else if ((ts.isFunctionDeclaration(st) || ts.isClassDeclaration(st)) && st.name) {
        names.add(st.name.text);
      }
    }
  } else if (ts.isForStatement(scope) || ts.isForInStatement(scope) || ts.isForOfStatement(scope)) {
    const init = scope.initializer;
    if (init && ts.isVariableDeclarationList(init)) {
      for (const d of init.declarations) collectBindingName(d.name, names);
    }
  } else if (ts.isCatchClause(scope)) {
    if (scope.variableDeclaration) collectBindingName(scope.variableDeclaration.name, names);
  }
  return names.has(name);
}

/**
 * Whether `id` (a value reference whose text is an imported binding name)
 * resolves to a *local* declaration that shadows the import, rather than to the
 * module-scope import itself. Walks ancestors to module scope; the first
 * enclosing scope that introduces the name wins (lexical shadowing). Reaching
 * the `SourceFile` means the import — imports live at module scope and cannot be
 * shadowed there. Only a confident local resolution discounts the reference, so
 * a genuine import use is never miscounted (no false strips).
 */
function isShadowedLocally(id: ts.Identifier): boolean {
  const name = id.text;
  for (let n: ts.Node = id; n.parent; n = n.parent) {
    const parent = n.parent;
    if (ts.isSourceFile(parent)) return false; // module scope → the import
    // Skip `parent`'s bindings when the reference reached it via a position that
    // evaluates in the ENCLOSING scope — a function-like member's computed name
    // or decorators (NEW-3). Keep walking to the true enclosing scope.
    if (inParentOwnScope(parent, n) && scopeIntroduces(parent, name)) return true;
  }
  return false;
}

/**
 * Determine which local binding names are referenced *exclusively* inside
 * stripped spans (and thus safe to prune). A name is kept if it has any
 * reference outside a stripped span; pruned only if it has ≥1 reference inside a
 * stripped span and 0 outside — pre-existing unused imports (0 inside, 0
 * outside) are left untouched. References are resolved to their lexical binding,
 * so a kept step (`render`) declaring a local that *shadows* an import name does
 * not keep the import alive (finding 6): the shadowed references bind to the
 * local, not the import.
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
    if (isShadowedLocally(n)) return; // binds to a local shadow, not the import
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
