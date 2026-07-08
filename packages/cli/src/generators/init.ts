/**
 * `rpxd init` — scaffold a new app to the documented userland tree
 * (docs/routes-and-auth.md). Auth + db are on by default; `--no-auth` keeps db
 * (anonymous `sid` scoping), `--no-db` strips both (memory storage). Never
 * edits files it didn't create; anything hand-owned (running `bun install`,
 * `prisma db push`) is printed, not applied.
 */

import { appShellFiles } from "./templates/app.ts";
import { authFiles } from "./templates/auth.ts";
import { dbFiles } from "./templates/db.ts";
import type { GeneratorPlan } from "./types.ts";

/** Inputs for {@link planInit}. */
export interface InitOptions {
  /** Package name (usually the target directory's basename). */
  name: string;
  /** Wire Better Auth (implies db). Default true. */
  auth: boolean;
  /** Wire Prisma/SQLite. Default true; `false` forces `auth` off. */
  db: boolean;
}

/**
 * Build the file plan for a new app. `auth` without `db` is impossible (Better
 * Auth needs the Prisma adapter), so `db: false` forces `auth: false` and the
 * plan records that in its steps.
 *
 * @example
 * ```ts
 * planInit({ name: "my-app", auth: true, db: true });
 * ```
 */
export function planInit(options: InitOptions): GeneratorPlan {
  const db = options.db;
  const auth = db && options.auth;
  const opts = { name: options.name, db, auth };

  const files = [...appShellFiles(opts)];
  if (db) files.push(...dbFiles(auth));
  if (auth) files.push(...authFiles());

  const steps: string[] = [];
  if (options.auth && !options.db) {
    steps.push("Auth needs a database — generated without auth because --no-db was set.");
  }

  const commands = ["bun install"];
  if (db) commands.push("bun run setup"); // prisma generate && prisma db push
  commands.push("bun run dev");

  return { files, steps, commands };
}
