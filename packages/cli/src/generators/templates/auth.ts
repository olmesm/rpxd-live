/**
 * Better Auth wiring templates: the `auth.ts` adapter, the login + protected
 * account pages, and the `/api/auth/*` delegation route. This is a file
 * scaffolder — it does NOT wrap Better Auth's config in an rpxd-flavored fluent
 * (docs/routes-and-auth.md forbids that leaky mirror); `auth.ts` is the real
 * library, yours to edit.
 */
import type { FileWrite } from "../types.ts";

const authAdapter = (): string => `/**
 * Authentication — Better Auth over the shared Prisma/SQLite adapter
 * (\`./db\`). \`auth.handler\` owns \`/api/auth/*\` (delegated from a \`route()\`);
 * \`auth.api.getSession\` resolves a request for \`rpxd.config\`'s \`authenticate\`.
 * \`trustedOrigins\` echoes the request origin so it works on any port.
 */
import { betterAuth } from "better-auth";
import { authAdapter } from "./db";

export const auth = betterAuth({
  database: authAdapter,
  emailAndPassword: { enabled: true },
  secret: process.env.BETTER_AUTH_SECRET ?? "dev-secret-change-me-0123456789abcdef",
  trustedOrigins: (request?: Request) => (request ? [new URL(request.url).origin] : []),
});
`;

const apiAuthRoute = (): string => `/**
 * Auth issuance route (docs/routes-and-auth.md): a \`route()\` whose body
 * delegates the whole \`/api/auth/*\` subtree to the auth library. \`.all\`
 * forwards every method — the library owns sign-up/in/out and session.
 */
import { route } from "@rpxd/core";
import { auth } from "../adapters/auth";

export default route("/api/auth/$").all((req) => auth.handler(req));
`;

const loginRoute = (): string => `import { live } from "@rpxd/core";

/**
 * Login page. Issuance is HTTP, not an rpc (it must set a cookie), so the form
 * posts to the auth route (\`/api/auth/*\`); then a full navigation re-runs
 * \`authenticate\` with the new session (docs/routes-and-auth.md).
 */
export default live("/login")
  .mount(async () => ({ error: "" as string }))
  .rpc("setError", (r) =>
    r.handler(async ({ message }: { message: string }, ctx) => {
      ctx.patchState((s) => {
        s.error = message;
      });
    }),
  )
  .render(({ state, rpc }) => {
    const submit = (action: "sign-in" | "sign-up") => async (form: HTMLFormElement) => {
      const data = new FormData(form);
      const email = String(data.get("email") ?? "");
      const res = await fetch(\`/api/auth/\${action}/email\`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password: data.get("password"), name: email }),
      });
      if (res.ok) window.location.assign("/");
      else {
        const body = (await res.json().catch(() => ({}))) as { message?: string; error?: string };
        void rpc.setError({ message: body.message ?? body.error ?? "sign in failed" });
      }
    };
    return (
      <main>
        <h1>sign in</h1>
        <form
          data-testid="login-form"
          onSubmit={(e) => {
            e.preventDefault();
            const submitter = (e.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null;
            const action = submitter?.value === "sign-up" ? "sign-up" : "sign-in";
            void submit(action)(e.currentTarget);
          }}
        >
          <input name="email" type="email" placeholder="email" data-testid="email" />
          <input name="password" type="password" placeholder="password" data-testid="password" />
          <button type="submit" value="sign-in" data-testid="do-sign-in">
            sign in
          </button>
          <button type="submit" value="sign-up" data-testid="do-sign-up">
            sign up
          </button>
        </form>
        {state.error && <p data-testid="login-error">{state.error}</p>}
        <a href="/">back</a>
      </main>
    );
  });
`;

const accountRoute = (): string => `import { live, redirect } from "@rpxd/core";
import { scopeFrom } from "../domain/scope";

/**
 * A protected page. \`mount\` reads the scope and — when there's no user —
 * throws \`redirect("/login")\` (§10, docs/routes-and-auth.md): a full load gets
 * a 302, a soft \`Link\` navigation is bounced client-side.
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
      <a href="/">back</a>
    </main>
  ));
`;

/**
 * The Better Auth wiring files (adapter + auth routes). Pair with {@link dbFiles}
 * for the Prisma client the adapter consumes.
 *
 * @example
 * ```ts
 * authFiles(); // adapters/auth.ts, routes/{login,account}.tsx, routes/api.auth.$.ts
 * ```
 */
export function authFiles(): FileWrite[] {
  return [
    { path: "adapters/auth.ts", contents: authAdapter() },
    { path: "routes/login.tsx", contents: loginRoute() },
    { path: "routes/account.tsx", contents: accountRoute() },
    { path: "routes/api.auth.$.ts", contents: apiAuthRoute() },
  ];
}
