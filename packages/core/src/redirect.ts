/**
 * Server-side navigation from `setup`/`guard`/`load` (§10,
 * docs/routes-and-auth.md). Throwing `redirect("/login")` sends the visitor
 * elsewhere *before* the page renders: the server turns it into a `302` on a
 * full page load and a client navigation during SPA nav. This is the
 * login-bounce primitive — enforcement (checking `scope.user`) stays userland;
 * the redirect mechanism is the framework's. `guard` is auth's home (§7).
 */

/**
 * The signal a rejected hook throws to redirect. Carries the target
 * `location` and HTTP `status` (302 by default). Branded so `isRedirect`
 * works even across module realms. Prefer the {@link redirect} helper.
 *
 * @example
 * ```ts
 * throw new RedirectError("/login"); // usually: throw redirect("/login")
 * ```
 */
export class RedirectError extends Error {
  /** Discriminator for {@link isRedirect} (survives cross-realm instanceof gaps). */
  readonly $redirect = true as const;
  constructor(
    readonly location: string,
    readonly status: number = 302,
  ) {
    super(`redirect to ${location}`);
    this.name = "RedirectError";
  }
}

/**
 * Build a {@link RedirectError} to throw from `mount` (§10).
 *
 * @example
 * ```ts
 * .guard((_url, ctx) => {
 *   const scope = scopeFrom(ctx.session);
 *   if (!scope.user) throw redirect("/login");
 * })
 * ```
 */
export function redirect(to: string, status = 302): RedirectError {
  return new RedirectError(to, status);
}

/**
 * True when a thrown value is a {@link redirect} signal — used by the runtime
 * to turn it into a `302` / client navigation rather than the error route.
 *
 * @example
 * ```ts
 * try { await mount(); } catch (e) { if (isRedirect(e)) return location(e.location); }
 * ```
 */
export function isRedirect(value: unknown): value is RedirectError {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { $redirect?: unknown }).$redirect === true
  );
}
