/**
 * Supersession signal for latest-wins lifecycle races (§10). A newer URL
 * claiming the guard makes a still-running `authorize`'s outcome stale — deny
 * and allow alike. Resolving the stale run would read as an allow (an auth
 * bypass when the swallowed outcome was a deny), so it rejects with this
 * marker instead; callers catch it and bail quietly — the winning run owns
 * the outcome.
 */

/**
 * The rejection a superseded `authorize` run throws (§10). Branded so
 * {@link isSuperseded} works across module realms. Callers treat it as "bail
 * quietly": skip the load, mutate no response — never a 500.
 *
 * @example
 * ```ts
 * try {
 *   await instance.authorize(search);
 * } catch (e) {
 *   if (isSuperseded(e)) return; // a newer URL owns the outcome
 *   throw e;
 * }
 * ```
 */
export class SupersededError extends Error {
  /** Discriminator for {@link isSuperseded} (survives cross-realm instanceof gaps). */
  readonly $superseded = true as const;
  constructor() {
    super("superseded by a newer run");
    this.name = "SupersededError";
  }
}

/**
 * True when a thrown value is a {@link SupersededError} — used by `authorize`
 * callers to skip the stale run's load without surfacing an error.
 *
 * @example
 * ```ts
 * try { await instance.authorize(search); } catch (e) { if (!isSuperseded(e)) throw e; }
 * ```
 */
export function isSuperseded(value: unknown): value is SupersededError {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { $superseded?: unknown }).$superseded === true
  );
}
