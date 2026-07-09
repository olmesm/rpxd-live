import { PrismaLibSql } from "@prisma/adapter-libsql";
import { defineConfig } from "prisma/config";

const url = process.env.DATABASE_URL ?? "file:./prisma/dev.db";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: { path: "prisma/migrations" },
  datasource: { url },
  adapter: () => new PrismaLibSql({ url }),
});
