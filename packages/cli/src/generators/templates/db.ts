/**
 * Prisma/SQLite data-layer templates (`adapters/db.ts`, `prisma/schema.prisma`,
 * `prisma.config.ts`). The libsql driver adapter is used so the same client
 * runs on Bun (where better-sqlite3 won't). When `auth` is set, `db.ts` also
 * exports the Better Auth adapter and the schema carries its models.
 */
import type { FileWrite } from "../types.ts";

const AUTH_MODELS = `
model User {
  id            String    @id
  name          String
  email         String
  emailVerified Boolean   @default(false)
  image         String?
  createdAt     DateTime  @default(now())
  updatedAt     DateTime  @updatedAt
  sessions      Session[]
  accounts      Account[]

  @@unique([email])
  @@map("user")
}

model Session {
  id        String   @id
  expiresAt DateTime
  token     String
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
  ipAddress String?
  userAgent String?
  userId    String
  user      User     @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@unique([token])
  @@index([userId])
  @@map("session")
}

model Account {
  id                    String    @id
  accountId             String
  providerId            String
  userId                String
  user                  User      @relation(fields: [userId], references: [id], onDelete: Cascade)
  accessToken           String?
  refreshToken          String?
  idToken               String?
  accessTokenExpiresAt  DateTime?
  refreshTokenExpiresAt DateTime?
  scope                 String?
  password              String?
  createdAt             DateTime  @default(now())
  updatedAt             DateTime  @updatedAt

  @@index([userId])
  @@map("account")
}

model Verification {
  id         String   @id
  identifier String
  value      String
  expiresAt  DateTime
  createdAt  DateTime @default(now())
  updatedAt  DateTime @updatedAt

  @@index([identifier])
  @@map("verification")
}
`;

const dbAdapter = (auth: boolean): string => `/**
 * Data${auth ? " + auth" : ""} adapter — the server-only Prisma/SQLite client (via the libsql
 * driver adapter, which runs on Bun where better-sqlite3 won't).${
   auth
     ? " Better Auth\n * consumes \\`authAdapter\\`, kept here so db wiring and auth config stay separate."
     : ""
}
 * \`globalThis\`-cached so config, SSR/RSC, and the CLI graph share one client.
 */
import { PrismaLibSql } from "@prisma/adapter-libsql";
${auth ? 'import { prismaAdapter } from "better-auth/adapters/prisma";\n' : ""}import { PrismaClient } from "../generated/prisma/client.ts";

const dbFile = new URL("../prisma/dev.db", import.meta.url).pathname;
const url = process.env.DATABASE_URL ?? \`file:\${dbFile}\`;
const globals = globalThis as typeof globalThis & { __prisma?: PrismaClient };
export const db: PrismaClient =
  globals.__prisma ?? new PrismaClient({ adapter: new PrismaLibSql({ url }) });
if (!globals.__prisma) {
  // WAL: concurrent readers + a non-blocking writer (persisted; best-effort).
  void db.$executeRawUnsafe("PRAGMA journal_mode=WAL;").catch(() => {});
}
globals.__prisma = db;
${auth ? '\n/** Better Auth\'s Prisma adapter (SQLite) over the shared client. */\nexport const authAdapter = prismaAdapter(db, { provider: "sqlite" });\n' : ""}`;

const schema = (auth: boolean): string => `generator client {
  provider = "prisma-client"
  output   = "../generated/prisma"
}

datasource db {
  provider = "sqlite"
}
${auth ? AUTH_MODELS : "\n// Add models here — `rpxd scaffold` prints a model to paste for each resource.\n"}`;

const prismaConfig = (): string => `import { PrismaLibSql } from "@prisma/adapter-libsql";
import { defineConfig } from "prisma/config";

const url = process.env.DATABASE_URL ?? "file:./prisma/dev.db";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: { path: "prisma/migrations" },
  datasource: { url },
  adapter: () => new PrismaLibSql({ url }),
});
`;

/**
 * The Prisma data-layer files. Pass `auth` to include the Better Auth adapter
 * export and its models.
 *
 * @example
 * ```ts
 * dbFiles(true); // db.ts with authAdapter + schema with auth models
 * ```
 */
export function dbFiles(auth: boolean): FileWrite[] {
  return [
    { path: "adapters/db.ts", contents: dbAdapter(auth) },
    { path: "prisma/schema.prisma", contents: schema(auth) },
    { path: "prisma.config.ts", contents: prismaConfig() },
  ];
}

/** The Better Auth Prisma models, printed when auth is added to an existing db. */
export const authPrismaModels = AUTH_MODELS.trim();
