/**
 * Shared shapes for the file-generating commands (`init`, `auth`, `scaffold`).
 *
 * A generator is a pure `plan()` that returns a {@link GeneratorPlan} — the
 * files to write, blocks to *append*, and the steps/commands to *print*. It
 * never rewrites existing content in a hand-owned file (the routes & auth guide:
 * "the framework maintains the mirror, not the logic"): it only writes new files
 * or appends new blocks; anything else is surfaced as a printed instruction.
 * {@link applyPlan} does the disk IO.
 */

/** One file a generator wants to write, path relative to the project root. */
export interface FileWrite {
  /** Destination path, relative to the project root (POSIX separators). */
  path: string;
  /** Full file contents. */
  contents: string;
}

/**
 * A block appended to an existing file (e.g. a Prisma model into
 * `schema.prisma`). Append-only and idempotent: skipped when `marker` is
 * already present in the file, and when the file doesn't exist.
 */
export interface AppendBlock {
  /** Target file, relative to the project root. */
  path: string;
  /** Substring whose presence means the block is already there (e.g. `model Post `). */
  marker: string;
  /** The block to append. */
  content: string;
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
  /** Blocks to append to existing files (append-only, idempotent). */
  appends?: AppendBlock[];
  /** Prose follow-ups to print — e.g. config snippets to paste. */
  steps: string[];
  /** Copy-pasteable shell commands to run after generation. */
  commands: string[];
}
