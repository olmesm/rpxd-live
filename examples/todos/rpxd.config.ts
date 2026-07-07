import { defineConfig } from "@rpxd/cli";

export default defineConfig({
  // memory() storage and sse() transport are the defaults (§14)
  rsc: true, // §16 experimental flag — flipped after ①–⑤ went green
  // Scope every session to its resolved id (§10). ctx.session carries this;
  // the domain layer turns it into a Scope (see docs/domain-layer.md).
  session: { authenticate: (_req, { sid }) => ({ sid }) },
});
