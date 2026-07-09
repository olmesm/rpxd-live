import { live } from "@rpxd/core";
import { authClient } from "../adapters/auth-client";

/**
 * Login page. Issuance is HTTP, not an rpc (it must set a cookie), so it uses
 * Better Auth's own client (`authClient.signIn/signUp`, which posts to
 * `/api/auth/*`); then a full navigation re-runs `authenticate` with the new
 * session — see the routes & auth guide.
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
      const password = String(data.get("password") ?? "");
      // Better Auth's typed client — sign-up needs a name.
      const res =
        action === "sign-up"
          ? await authClient.signUp.email({ email, password, name: email })
          : await authClient.signIn.email({ email, password });
      if (!res.error) window.location.assign("/");
      else void rpc.setError({ message: res.error.message ?? "sign in failed" });
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
