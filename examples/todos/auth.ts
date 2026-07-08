/**
 * Authentication — Better Auth backed by the shared Prisma/SQLite client
 * (`db.ts`). This is the real library at the seam `docs/routes-and-auth.md`
 * describes: `auth.handler` owns `/api/auth/*` (delegated from a `route()`),
 * `auth.api.getSession` resolves a request for `rpxd.config`'s `authenticate`.
 *
 * `trustedOrigins` echoes the request origin so the demo works on any port
 * (dev :3000, e2e :4517) without hardcoding a `baseURL`.
 */
import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { prisma } from "./prisma";

export const auth = betterAuth({
  database: prismaAdapter(prisma, { provider: "sqlite" }),
  emailAndPassword: { enabled: true },
  secret: process.env.BETTER_AUTH_SECRET ?? "rpxd-todos-dev-secret-change-me-0123456789",
  // Called with no request during init; echo the request origin otherwise.
  trustedOrigins: (request?: Request) => (request ? [new URL(request.url).origin] : []),
});
