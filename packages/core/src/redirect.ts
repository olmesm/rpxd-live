/**
 * Server-side navigation from `setup`/`guard`/`load` (§10, the routes & auth
 * guide). Throwing `redirect("/login")` sends the visitor elsewhere *before* the
 * page renders: the server turns it into a `302` on a full page load and a
 * client navigation during SPA nav. This is the login-bounce primitive —
 * enforcement (checking `scope.user`) stays userland; the redirect mechanism is
 * the framework's. `guard` is auth's home (§7).
 */

import type { RedirectTarget } from "./register.ts";

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
  readonly location: string;
  readonly status: number;
  // Plain field assignment (not a parameter property) so the source stays
  // erasable — Node runs it under default, unflagged TypeScript stripping.
  constructor(location: string, status = 302) {
    super(`redirect to ${location}`);
    this.location = location;
    this.status = status;
    this.name = "RedirectError";
  }
}

/**
 * Build a {@link RedirectError} to throw from `setup`/`guard`/`load` (§10).
 *
 * `to` autocompletes your app's {@link RegisteredPath}s (like `Link`/`nav`) but
 * still accepts any string — a redirect target is a final URL, so dynamic
 * values, query strings, and non-page paths like `/403` are all valid.
 *
 * @example
 * ```ts
 * .guard((_url, ctx) => {
 *   const scope = scopeFrom(ctx.session);
 *   if (!scope.user) throw redirect("/login"); // "/login" autocompletes
 * })
 * ```
 */
export function redirect(to: RedirectTarget, status = 302): RedirectError {
  return new RedirectError(to, status);
}

/**
 * True when a thrown value is a {@link redirect} signal — used by the runtime
 * to turn it into a `302` / client navigation rather than the error route.
 *
 * @example
 * ```ts
 * try { await load(); } catch (e) { if (isRedirect(e)) return location(e.location); }
 * ```
 */
export function isRedirect(value: unknown): value is RedirectError {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { $redirect?: unknown }).$redirect === true
  );
}
