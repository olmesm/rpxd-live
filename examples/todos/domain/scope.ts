/**
 * Scope — who is acting (docs/routes-and-auth.md). Kept in its own module, free
 * of any `db`/Prisma import, so the render component (which runs on the client)
 * can call `scopeFrom(session)` without dragging the server-only data layer
 * into the client bundle. `domain/todos.ts` and the config import `Scope` here.
 */

/** The authenticated user, when signed in (from the auth library). */
export interface ScopeUser {
  id: string;
  email: string;
}

/**
 * Who is acting. Built from `ctx.session` (rpxd.config `authenticate`) — the
 * framework session id plus the authenticated user, if any.
 */
export interface Scope {
  sid: string;
  user?: ScopeUser;
}

/** Derive a {@link Scope} from the untyped `ctx.session` bag. */
export function scopeFrom(session: unknown): Scope {
  const s = (session ?? {}) as { sid?: unknown; user?: ScopeUser };
  return { sid: typeof s.sid === "string" ? s.sid : "anonymous", user: s.user };
}
