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
 * API shape identical. Served by both `rpxd dev` (via `ws` on the shared
 * port) and `rpxd start` (Bun.serve upgrade) — dev/prod parity.
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
  /**
   * Authenticate once at connect (§10) → `ctx.session` everywhere. The second
   * arg carries the framework's resolved session id (`sid`) — the same
   * identity used for instance routing and storage — so the returned value can
   * be scoped to it (e.g. `(_req, { sid }) => ({ sid })`).
   */
  session?: {
    authenticate?: (req: Request, ctx: { sid: string }) => unknown | Promise<unknown>;
  };
  /**
   * Cross-origin allowlist for the rpxd control plane (`/__rpxd/ws|stream|rpc|
   * control`, #52). Defaults to **same-origin only** — the cross-site
   * WebSocket-hijack / CSRF defense. Leave unset for a normal same-origin app;
   * a deliberate cross-origin deployment lists its origins (or passes a
   * predicate). `["*"]` opts back into the pre-#52 any-origin behavior.
   *
   * @example
   * ```ts
   * export default defineConfig({ allowedOrigins: ["https://admin.example.com"] });
   * ```
   */
  allowedOrigins?: readonly string[] | ((origin: string) => boolean);
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

/**
 * Config values the CLI can override via flags — `--transport <sse|ws>` and
 * `--rsc` / `--no-rsc`. Handy for testing one app across the render/transport
 * combinations (CI matrix) without editing `rpxd.config.ts`.
 */
export interface ConfigOverrides {
  transport?: "sse" | "ws";
  rsc?: boolean;
}

/**
 * Apply CLI flag overrides onto a loaded config (mutates and returns it).
 *
 * @example
 * ```ts
 * applyConfigOverrides(config, { transport: "ws", rsc: false });
 * ```
 */
export function applyConfigOverrides(config: RpxdConfig, overrides?: ConfigOverrides): RpxdConfig {
  if (overrides?.transport) config.transport = { kind: overrides.transport };
  if (overrides?.rsc !== undefined) config.rsc = overrides.rsc;
  return config;
}
