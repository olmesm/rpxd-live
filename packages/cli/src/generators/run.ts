/**
 * Shared execution for the generator commands: apply a {@link GeneratorPlan} to
 * disk, refresh route codegen, and print the result (created/skipped files,
 * follow-up steps, and next commands) with consola. Kept apart from the pure
 * `plan*` functions so those stay testable without IO or a logger.
 */

import { runCodegen } from "@rpxd/vite-plugin";
import { consola } from "consola";
import { applyPlan } from "./apply.ts";
import type { GeneratorPlan } from "./types.ts";

/** Options for {@link runPlan}. */
export interface RunPlanOptions {
  /** Overwrite existing files. */
  force?: boolean;
  /** Re-run route codegen after writing (init/scaffold/auth add routes). */
  codegen?: boolean;
}

/**
 * Apply `plan` under `root` and report it. Returns the number of files written
 * so callers can tailor their closing message.
 *
 * @example
 * ```ts
 * runPlan(cwd, planScaffold(opts), { codegen: true });
 * ```
 */
export function runPlan(root: string, plan: GeneratorPlan, options: RunPlanOptions = {}): number {
  const { written, skipped } = applyPlan(root, plan, { force: options.force });

  for (const path of written) consola.success(`created ${path}`);
  for (const path of skipped) {
    consola.warn(`skipped ${path} (already exists — pass --force to overwrite)`);
  }

  if (options.codegen) runCodegen(root);

  for (const step of plan.steps) consola.info(step);

  if (plan.commands.length > 0) {
    consola.log("");
    consola.log("Next steps:");
    for (const command of plan.commands) consola.log(`  ${command}`);
  }

  return written.length;
}
