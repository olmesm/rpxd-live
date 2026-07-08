/**
 * Server-only Prisma client — eager, so `auth.ts` (Better Auth's adapter needs
 * it synchronously) and the lazy loader in `db.ts` share one instance. Never
 * import this from a client-bundled module: `@prisma/client` calls
 * `fileURLToPath` at init and crashes in the browser. `db.ts` reaches it via a
 * dynamic import so the route components stay client-safe.
 *
 * `globalThis`-cached: the config graph, the Vite SSR/RSC graphs, and the CLI
 * all import through here, so a plain module-level client would multiply.
 */
import { PrismaLibSql } from "@prisma/adapter-libsql";
import { PrismaClient } from "./generated/prisma/client.ts";

const dbFile = new URL("./prisma/dev.db", import.meta.url).pathname;
const url = process.env.DATABASE_URL ?? `file:${dbFile}`;
const globals = globalThis as typeof globalThis & { __todosPrisma?: PrismaClient };
export const prisma: PrismaClient =
  globals.__todosPrisma ?? new PrismaClient({ adapter: new PrismaLibSql({ url }) });
if (!globals.__todosPrisma) {
  // WAL: concurrent readers + a non-blocking writer — keeps the single SQLite
  // file responsive when several sessions write at once. Persists to the file;
  // best-effort so a read-only FS can't break startup.
  void prisma.$executeRawUnsafe("PRAGMA journal_mode=WAL;").catch(() => {});
}
globals.__todosPrisma = prisma;
