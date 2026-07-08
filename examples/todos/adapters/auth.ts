/**
 * Authentication — Better Auth over the shared Prisma/SQLite adapter
 * (`./db`). This is the real library at the seam `docs/routes-and-auth.md`
 * describes: `auth.handler` owns `/api/auth/*` (delegated from a `route()`),
 * `auth.api.getSession` resolves a request for `rpxd.config`'s `authenticate`.
 *
 * `trustedOrigins` echoes the request origin so the demo works on any port
 * (dev :3000, e2e :4517) without hardcoding a `baseURL`.
 */
import { betterAuth } from "better-auth";
import { authAdapter } from "./db";

export const auth = betterAuth({
  database: authAdapter,
  emailAndPassword: { enabled: true },
  secret: process.env.BETTER_AUTH_SECRET ?? "rpxd-todos-dev-secret-change-me-0123456789",
  // Called with no request during init; echo the request origin otherwise.
  trustedOrigins: (request?: Request) => (request ? [new URL(request.url).origin] : []),
});
