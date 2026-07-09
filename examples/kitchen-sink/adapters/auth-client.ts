/**
 * Better Auth browser client — issuance only (sign in / up / out). It's the
 * real library's own client, so the login/logout call sites use typed methods
 * instead of hand-rolled `fetch` (the routes & auth guide: use the library, not
 * a mirror of it).
 *
 * Session *reads* stay server-authoritative via rpxd's `session` render prop
 * (`scopeFrom(session)`) — so we deliberately do NOT use `authClient.useSession()`,
 * which would be a second, client-fetched source of truth racing rpxd's.
 *
 * `baseURL` is omitted: the client resolves the current origin at fetch time
 * (client-side), matching `auth.ts`'s request-origin `trustedOrigins` — it works
 * on any port with no hardcoded URL.
 */
import { createAuthClient } from "better-auth/react";

export const authClient = createAuthClient();
