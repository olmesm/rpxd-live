import { defineConfig } from "@rpxd/cli";
import { auth } from "./adapters/auth";

export default defineConfig({
  // memory() storage and sse() transport are the defaults (§14)
  rsc: true, // §16 experimental flag — flipped after ①–⑤ went green
  // Resolve every request → a Scope (§10, the routes & auth guide): the
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
  // Server-wide logging (the logging & observability guide): every framework
  // diagnostic — request failures, security warnings, instance errors — flows
  // through this one sink. Forward EVERYTHING by level; filter noise out (the
  // CI gate below), never allowlist kinds in, or you'll silently drop
  // security warnings. Swap the console call for your logger in one line,
  // e.g. pino: logger[d.level]({ ...d.detail, err: d.error }, `${d.category}/${d.type}`)
  onDiagnostic(d) {
    if (process.env.CI && (d.level === "info" || d.level === "debug")) return; // quiet CI, never swallow warn/error
    console[d.level](`[${d.category}/${d.type}]`, d.detail ?? "", d.error ?? "");
  },
});
