/**
 * `rpxd.config.ts` surface (§14): the only non-route file in userland.
 */
import type { RateLimit, StorageAdapter } from "@rpxd/core";

/** Transport selection (§11): SSE default, WS opt-in. */
export interface TransportConfig {
  kind: "sse" | "ws";
}

/**
 * Server → client over SSE, client → server over HTTP POST (default, §11).
 *
 * @example
 * ```ts
 * export default defineConfig({ transport: sse() });
 * ```
 */
export function sse(): TransportConfig {
  return { kind: "sse" };
}

/**
 * Single duplex WebSocket (opt-in, §11). The envelope is transport-agnostic;
 * API shape identical. (v1 runtime currently serves the SSE path; the ws
 * upgrade lands behind this flag without codegen impact.)
 *
 * @example
 * ```ts
 * export default defineConfig({ transport: ws() });
 * ```
 */
export function ws(): TransportConfig {
  return { kind: "ws" };
}

/** The shape `defineConfig` accepts (§14). */
export interface RpxdConfig {
  /** Storage adapter (§9). Default: `memory()`. */
  storage?: StorageAdapter;
  /** Transport (§11). Default: `sse()`. */
  transport?: TransportConfig;
  /** Authenticate once at connect (§10) → `ctx.session` everywhere. */
  session?: { authenticate?: (req: Request) => unknown | Promise<unknown> };
  /** RSC fields flag (§16). Default false — v1 is complete without it. */
  rsc?: boolean;
  /** Default per-rpc token bucket (§10). */
  rateLimit?: RateLimit;
}

/**
 * Define the rpxd app config.
 *
 * @example
 * ```ts
 * // rpxd.config.ts
 * export default defineConfig({
 *   storage: sqlite("./data.db"),
 *   session: { authenticate: (req) => getSession(req) },
 * });
 * ```
 */
export function defineConfig(config: RpxdConfig): RpxdConfig {
  return config;
}
