/**
 * Disk IO for generators: writes a {@link GeneratorPlan}'s files under a project
 * root, never clobbering an existing file unless `force` is set. Idempotent —
 * a file whose content already matches is left untouched and reported skipped.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { GeneratorPlan } from "./types.ts";

/** What {@link applyPlan} did — relative paths written vs. left alone. */
export interface ApplyResult {
  /** Paths written this run. */
  written: string[];
  /** Paths skipped (already present; pass `force` to overwrite). */
  skipped: string[];
}

/** Options for {@link applyPlan}. */
export interface ApplyOptions {
  /** Overwrite files that already exist (still skips byte-identical ones). */
  force?: boolean;
}

/**
 * Write a plan's files under `root`.
 *
 * @example
 * ```ts
 * const { written, skipped } = applyPlan(root, plan, { force: false });
 * ```
 */
export function applyPlan(
  root: string,
  plan: GeneratorPlan,
  options: ApplyOptions = {},
): ApplyResult {
  const written: string[] = [];
  const skipped: string[] = [];
  for (const file of plan.files) {
    const abs = join(root, file.path);
    const exists = existsSync(abs);
    if (exists) {
      const current = readFileSync(abs, "utf-8");
      if (current === file.contents) {
        skipped.push(file.path);
        continue;
      }
      if (!options.force) {
        skipped.push(file.path);
        continue;
      }
    }
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, file.contents);
    written.push(file.path);
  }
  return { written, skipped };
}
