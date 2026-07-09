import { defineConfig } from "@rpxd/cli";
import { auth } from "./adapters/auth";

export default defineConfig({
  // memory() storage and sse() transport are the defaults (§14)
  rsc: true, // §16 experimental flag — flipped after ①–⑤ went green
  // Resolve every request → a Scope (§10, docs/routes-and-auth.md): the
  // framework sid plus the authenticated user (if signed in). Project Better
  // Auth's session down to a STABLE { id, email } — returning its full session
  // (rolling token/expiry) would differ every request and thrash the
  // warm-instance re-mount. ctx.session carries this; the domain layer scopes.
  session: {
    authenticate: async (req, { sid }) => {
      const s = await auth.api.getSession({ headers: req.headers });
      return { sid, user: s?.user ? { id: s.user.id, email: s.user.email } : undefined };
    },
  },
});
