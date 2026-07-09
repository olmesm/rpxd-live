import { live, redirect } from "@rpxd/core";
import { scopeFrom } from "../domain/scope";

/**
 * A protected page. Its state *is* the user, so the check lives in `setup`
 * (which runs before `guard`): reading the scope and — when there's no user —
 * throwing `redirect("/login")` (§10, docs/routes-and-auth.md) is the coarse
 * fail-fast. A full load gets a 302, a soft `Link` navigation is bounced
 * client-side. (`guard` is auth's idiom when state doesn't depend on identity.)
 */
export default live("/account")
  .setup((ctx) => {
    const scope = scopeFrom(ctx.session);
    if (!scope.user) throw redirect("/login");
    return { email: scope.user.email };
  })
  .render(({ state }) => (
    <main>
      <h1>account</h1>
      <p data-testid="account-email">signed in as {state.email}</p>
      <a href="/">back to todos</a>
    </main>
  ));
