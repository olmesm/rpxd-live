/**
 * Data + auth adapter — the server-only Prisma/SQLite client (via the libsql
 * driver adapter, which works on Bun where better-sqlite3 won't) plus the
 * Better Auth adapter built on it.
 *
 * `db` **is** the Prisma client; the domain layer queries it directly (lazily,
 * so it never enters the client bundle). Better Auth consumes `authAdapter` —
 * defined here rather than in `auth.ts` so db wiring and auth config stay
 * separate. `globalThis`-cached: config, SSR/RSC, and CLI graphs share one
 * client.
 */
import { PrismaLibSql } from "@prisma/adapter-libsql";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { PrismaClient } from "../generated/prisma/client.ts";

const dbFile = new URL("../prisma/dev.db", import.meta.url).pathname;
const url = process.env.DATABASE_URL ?? `file:${dbFile}`;
const globals = globalThis as typeof globalThis & { __todosPrisma?: PrismaClient };
export const db: PrismaClient =
  globals.__todosPrisma ?? new PrismaClient({ adapter: new PrismaLibSql({ url }) });
if (!globals.__todosPrisma) {
  // WAL: concurrent readers + a non-blocking writer (persisted; best-effort).
  void db.$executeRawUnsafe("PRAGMA journal_mode=WAL;").catch(() => {});
}
globals.__todosPrisma = db;

/** Better Auth's Prisma adapter (SQLite) over the shared client. */
export const authAdapter = prismaAdapter(db, { provider: "sqlite" });
