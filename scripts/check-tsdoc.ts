#!/usr/bin/env bun
/**
 * TSDoc enforcement (§17): every exported declaration in package src dirs must
 * carry a doc comment, and exported functions/classes (the callable API
 * surface) must include an `@example` block. Re-exports (`export { ... } from`)
 * and type-only re-exports are exempt — they're documented at their definition.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const roots = readdirSync("packages")
  .map((p) => join("packages", p, "src"))
  .filter((p) => {
    try {
      return statSync(p).isDirectory();
    } catch {
      return false;
    }
  });

const DECL =
  /^export\s+(?:default\s+)?(?:async\s+)?(function|class|interface|type|const|enum|abstract class)\b/;

const failures: string[] = [];

/**
 * Blank the *contents* of string and template literals (and comments), keeping
 * newlines so line numbers are preserved. Generated code lives inside template
 * literals here (the CLI templates), so an `export` there is data, not an API
 * declaration — this stops the line scanner below from flagging it.
 */
function blankLiterals(src: string): string {
  const out: string[] = [];
  // Context stack. `${` inside a template pushes an expression context that
  // tracks brace depth so the matching `}` returns to the template.
  type Ctx =
    | { kind: "normal" }
    | { kind: "line" }
    | { kind: "block" }
    | { kind: "sq" }
    | { kind: "dq" }
    | { kind: "tmpl" }
    | { kind: "expr"; depth: number };
  const stack: Ctx[] = [{ kind: "normal" }];
  const top = () => stack[stack.length - 1] as Ctx;

  for (let i = 0; i < src.length; i++) {
    const c = src[i] as string;
    const next = src[i + 1];
    const ctx = top();
    const keep = () => out.push(c);
    const hide = () => out.push(c === "\n" ? "\n" : " ");

    switch (ctx.kind) {
      case "normal":
      case "expr": {
        if (ctx.kind === "expr") {
          if (c === "{") ctx.depth++;
          else if (c === "}") {
            if (ctx.depth === 0) {
              stack.pop(); // back to the enclosing template
              keep();
              break;
            }
            ctx.depth--;
          }
        }
        if (c === "/" && next === "/") stack.push({ kind: "line" });
        else if (c === "/" && next === "*") stack.push({ kind: "block" });
        else if (c === "'") stack.push({ kind: "sq" });
        else if (c === '"') stack.push({ kind: "dq" });
        else if (c === "`") stack.push({ kind: "tmpl" });
        keep();
        break;
      }
      case "line":
        // Keep comment text intact (docs live here); just don't let a stray
        // backtick in a comment start a template.
        if (c === "\n") stack.pop();
        keep();
        break;
      case "block":
        if (c === "*" && next === "/") {
          keep();
          out.push(src[i + 1] as string);
          i++;
          stack.pop();
        } else keep();
        break;
      case "sq":
      case "dq": {
        const quote = ctx.kind === "sq" ? "'" : '"';
        if (c === "\\") {
          hide();
          if (src[i + 1] !== undefined) {
            out.push(src[i + 1] === "\n" ? "\n" : " ");
            i++;
          }
        } else if (c === quote) {
          stack.pop();
          keep();
        } else hide();
        break;
      }
      case "tmpl":
        if (c === "\\") {
          hide();
          if (src[i + 1] !== undefined) {
            out.push(src[i + 1] === "\n" ? "\n" : " ");
            i++;
          }
        } else if (c === "`") {
          stack.pop();
          keep();
        } else if (c === "$" && next === "{") {
          keep(); // keep `$`
          out.push("{"); // keep `{`
          i++;
          stack.push({ kind: "expr", depth: 0 });
        } else hide();
        break;
    }
  }
  return out.join("");
}

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return walk(path);
    return /\.(ts|tsx)$/.test(name) && !/\.test(-d)?\./.test(name) ? [path] : [];
  });
}

for (const root of roots) {
  for (const file of walk(root)) {
    const raw = readFileSync(file, "utf-8");
    const lines = raw.split("\n");
    // Declaration detection runs on a copy with string/template contents
    // blanked, so `export` inside a generated-code template isn't mistaken for
    // a real API declaration. Doc/@example look-back uses the original lines.
    const scanLines = blankLiterals(raw).split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = scanLines[i] as string;
      if (!DECL.test(line)) continue;
      if (/^export\s+(type\s+)?\{/.test(line)) continue; // re-exports documented at source
      // look back over blank lines & decorators for the end of a doc block
      let j = i - 1;
      while (
        j >= 0 &&
        ((lines[j] as string).trim() === "" || (lines[j] as string).trim().startsWith("//"))
      )
        j--;
      const prev = (lines[j] ?? "").trim();
      const documented = prev.endsWith("*/");
      if (!documented) {
        failures.push(`${file}:${i + 1}  ${line.trim().slice(0, 80)}`);
        continue;
      }
      // Callable surface (§17): functions and classes need an @example block.
      const kind = DECL.exec(line)?.[1];
      if (kind !== "function" && kind !== "class" && kind !== "abstract class") continue;
      let k = j;
      let hasExample = false;
      while (k >= 0) {
        const doc = (lines[k] as string).trim();
        if (doc.includes("@example")) hasExample = true;
        if (doc.startsWith("/**") || doc.startsWith("/*")) break;
        k--;
      }
      if (!hasExample) {
        failures.push(`${file}:${i + 1}  missing @example — ${line.trim().slice(0, 60)}`);
      }
    }
  }
}

if (failures.length > 0) {
  console.error(`Missing TSDoc on ${failures.length} exported declaration(s):\n`);
  for (const f of failures) console.error(`  ${f}`);
  process.exit(1);
}
console.log("TSDoc check passed: all exported declarations documented.");
