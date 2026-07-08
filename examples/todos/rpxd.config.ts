import { defineConfig } from "@rpxd/cli";
import { auth } from "./auth";

export default defineConfig({
  // memory() storage and sse() transport are the defaults (§14)
  rsc: true, // §16 experimental flag — flipped after ①–⑤ went green
  // Resolve every request → a Scope (§10, docs/routes-and-auth.md): the
  // framework sid plus the authenticated user (if signed in). ctx.session
  // carries this; the domain layer turns it into a Scope.
  session: {
    authenticate: (req, { sid }) => ({ sid, user: auth.getSession(req)?.user }),
  },
});
