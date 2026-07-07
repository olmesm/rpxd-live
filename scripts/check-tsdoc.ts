#!/usr/bin/env bun
/**
 * TSDoc enforcement (§17): every exported declaration in package src dirs must
 * carry a doc comment. Re-exports (`export { ... } from`) and type-only
 * re-exports are exempt — they're documented at their definition.
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

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return walk(path);
    return /\.(ts|tsx)$/.test(name) && !/\.test(-d)?\./.test(name) ? [path] : [];
  });
}

for (const root of roots) {
  for (const file of walk(root)) {
    const lines = readFileSync(file, "utf-8").split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] as string;
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
      if (!documented) failures.push(`${file}:${i + 1}  ${line.trim().slice(0, 80)}`);
    }
  }
}

if (failures.length > 0) {
  console.error(`Missing TSDoc on ${failures.length} exported declaration(s):\n`);
  for (const f of failures) console.error(`  ${f}`);
  process.exit(1);
}
console.log("TSDoc check passed: all exported declarations documented.");
