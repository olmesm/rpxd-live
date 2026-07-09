import { live, redirect } from "@rpxd/core";
import { scopeFrom } from "../domain/scope";

/**
 * A protected page. `mount` reads the scope and — when there's no user —
 * throws `redirect("/login")` (§10, the routes & auth guide): a full load
 * gets a 302, a soft `Link` navigation is bounced client-side. Enforcement
 * lives here in userland; the redirect mechanism is the framework's.
 */
export default live("/account")
  .mount(async (_params, ctx) => {
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
