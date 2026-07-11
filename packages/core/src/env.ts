/**
 * Whether the process is running in development. rpxd is **secure by default**:
 * this is the ONLY environment relaxation, and it is a positive `isDev` check —
 * exactly `NODE_ENV === "development"` — so any other value (unset, "staging",
 * "test", a typo) is treated as production and keeps every fail-closed guard on.
 * Never invert this into an `isProd` check.
 *
 * @example
 * ```ts
 * if (!isDev()) throw new Error("refusing to start without a signing secret");
 * ```
 */
export function isDev(): boolean {
  return process.env.NODE_ENV === "development";
}
