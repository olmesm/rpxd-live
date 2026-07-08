/**
 * Feature detection for an existing app, so `scaffold` can generate auth-aware
 * output: a project with a db adapter gets Prisma-backed domain code, one with
 * an auth adapter gets user-scoped queries and the `--protected` mount gate.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";

/** Which optional pieces an app has wired in. */
export interface ProjectFeatures {
  /** `adapters/db.ts` exists — Prisma-backed domain layer. */
  hasDb: boolean;
  /** `adapters/auth.ts` exists — user-scoped, protectable routes. */
  hasAuth: boolean;
}

/**
 * Probe a project root for the db/auth seams (docs/routes-and-auth.md).
 *
 * @example
 * ```ts
 * detectFeatures("/path/to/app"); // { hasDb: true, hasAuth: false }
 * ```
 */
export function detectFeatures(root: string): ProjectFeatures {
  return {
    hasDb: existsSync(join(root, "adapters", "db.ts")),
    hasAuth: existsSync(join(root, "adapters", "auth.ts")),
  };
}
