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
  /** `path` of each append that was applied. */
  appended: string[];
  /** Appends skipped because the block (or its target file) was already/​not there. */
  appendSkipped: string[];
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

  const appended: string[] = [];
  const appendSkipped: string[] = [];
  for (const block of plan.appends ?? []) {
    const abs = join(root, block.path);
    // Only append to a file that exists — otherwise the printed steps guide the
    // user. Idempotent: skip if the block's marker is already present.
    if (!existsSync(abs)) {
      appendSkipped.push(block.path);
      continue;
    }
    const current = readFileSync(abs, "utf-8");
    if (current.includes(block.marker)) {
      appendSkipped.push(block.path);
      continue;
    }
    const sep = current.endsWith("\n") ? "\n" : "\n\n";
    writeFileSync(abs, `${current}${sep}${block.content}\n`);
    appended.push(block.path);
  }

  return { written, skipped, appended, appendSkipped };
}
