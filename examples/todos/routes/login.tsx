import { live } from "@rpxd/core";

/**
 * Login page. Issuance is HTTP, not an rpc (it must set a cookie), so the form
 * posts to the auth route (`/api/auth/*`, owned by the auth library via
 * `route()`), then a full navigation re-runs `authenticate` with the new
 * session — see docs/routes-and-auth.md.
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
      // Better Auth email/password endpoints (sign-up needs a name).
      const res = await fetch(`/api/auth/${action}/email`, {
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
