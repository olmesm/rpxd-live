/**
 * Shared shapes for the file-generating commands (`init`, `auth`, `scaffold`).
 *
 * A generator is a pure `plan()` that returns a {@link GeneratorPlan} — the
 * files to write plus the steps/commands to *print*. It never edits an existing
 * config or `package.json` (docs/routes-and-auth.md: "the framework maintains
 * the mirror, not the logic"): anything that would touch a hand-owned file is
 * surfaced as a printed instruction instead. {@link applyPlan} does the disk IO.
 */

/** One file a generator wants to write, path relative to the project root. */
export interface FileWrite {
  /** Destination path, relative to the project root (POSIX separators). */
  path: string;
  /** Full file contents. */
  contents: string;
}

/**
 * The output of a generator: files to write plus human-facing follow-ups the
 * CLI prints (never applied automatically).
 *
 * @example
 * ```ts
 * const plan: GeneratorPlan = {
 *   files: [{ path: "routes/index.tsx", contents: "…" }],
 *   steps: ["Add the authenticate hook to rpxd.config.ts"],
 *   commands: ["bun add better-auth"],
 * };
 * ```
 */
export interface GeneratorPlan {
  /** Files to write (skipped if they already exist unless `--force`). */
  files: FileWrite[];
  /** Prose follow-ups to print — e.g. config snippets to paste. */
  steps: string[];
  /** Copy-pasteable shell commands to run after generation. */
  commands: string[];
}
