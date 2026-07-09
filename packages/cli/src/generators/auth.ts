/**
 * `rpxd auth` — layer Better Auth + Prisma/SQLite onto an existing app. Writes
 * the auth files (and the db files if the app has none yet), and *prints* the
 * two things it must never own: the `rpxd.config.ts` `authenticate` hook and
 * the `package.json` deps (the routes & auth guide).
 */
import type { ProjectFeatures } from "./detect.ts";
import { authFiles } from "./templates/auth.ts";
import { authPrismaModels, dbFiles } from "./templates/db.ts";
import type { GeneratorPlan } from "./types.ts";

/** Inputs for {@link planAuth}. */
export interface AuthOptions {
  /** Detected app features — decides whether db files are also written. */
  features: ProjectFeatures;
}

const CONFIG_SNIPPET = `import { auth } from "./adapters/auth";

export default defineConfig({
  session: {
    authenticate: async (req, { sid }) => {
      const s = await auth.api.getSession({ headers: req.headers });
      return { sid, user: s?.user ? { id: s.user.id, email: s.user.email } : undefined };
    },
  },
});`;

/**
 * Build the auth file plan for an existing app.
 *
 * @example
 * ```ts
 * planAuth({ features: { hasDb: true, hasAuth: false } });
 * ```
 */
export function planAuth(options: AuthOptions): GeneratorPlan {
  const files = [...authFiles()];
  const steps: string[] = [];
  const commands: string[] = ["bun add better-auth"];

  if (!options.features.hasDb) {
    // No db yet — write the full Prisma layer (with the Better Auth adapter).
    files.push(...dbFiles(true));
    commands.unshift("bun add @libsql/client @prisma/adapter-libsql @prisma/client");
    commands.push("bun add -d prisma", "bun run setup");
  } else {
    // db exists and we won't clobber it — tell the user what to add by hand.
    steps.push(
      "Your adapters/db.ts already exists. Export the Better Auth adapter from it:\n\n" +
        '  import { prismaAdapter } from "better-auth/adapters/prisma";\n' +
        '  export const authAdapter = prismaAdapter(db, { provider: "sqlite" });',
    );
    steps.push(`Add the Better Auth models to prisma/schema.prisma:\n\n${authPrismaModels}`);
    commands.push("bun run db:push");
  }

  steps.push(`Wire the authenticate hook into rpxd.config.ts:\n\n${CONFIG_SNIPPET}`);

  return { files, steps, commands };
}
