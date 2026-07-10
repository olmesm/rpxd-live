/**
 * `rpxd.config.ts` surface (§14): the only non-route file in userland.
 */
import type { RateLimit, StorageAdapter } from "@rpxd/core";
import type { RpxdHandlerOptions, SecurityEvent } from "@rpxd/server-bun";

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
    /**
     * Session-cookie attributes (B1). `secure` marks `rpxd_sid` `Secure` —
     * default `true` (accepted on HTTPS and `http://localhost`). Set `false`
     * only for non-localhost HTTP dev. `bun run dev` already defaults it off.
     */
    cookie?: { secure?: boolean };
    /**
     * Secret for HMAC-signing the `rpxd_sid` cookie (B2) — a forged/unsigned
     * cookie is then rejected as a fresh session. Falls back to
     * `process.env.RPXD_SESSION_SECRET`. Unset → the sid is unsigned (the server
     * warns once). Set one in production.
     */
    secret?: string;
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
  /**
   * Opt-in request throttle (#6). `key(req)` returns the throttle key (from a
   * trusted source — a proxy-set header or peer address, not a spoofable raw
   * `X-Forwarded-For`) or `null` to skip; over-limit HTTP requests get `429`.
   * In-process (single node) — for multi-node, rate-limit at the proxy/edge.
   */
  throttle?: { key: (req: Request) => string | null; limit: RateLimit };
  /**
   * Tuning knobs for the in-memory instance registry (§11): warm/attach TTLs
   * and the capacity caps that bound memory under scan floods or a runaway
   * session (#61 — see each field's doc on {@link RpxdHandlerOptions} for
   * defaults and behavior). Forwarded straight through; omit a field to keep
   * its handler default.
   *
   * @example
   * ```ts
   * export default defineConfig({
   *   instances: { warmTtlMs: 5 * 60_000, maxUnattachedInstances: 200 },
   * });
   * ```
   */
  instances?: Pick<
    RpxdHandlerOptions,
    | "warmTtlMs"
    | "attachTtlMs"
    | "unattachedTtlMs"
    | "maxUnattachedInstances"
    | "maxInstancesPerSession"
  >;
  /**
   * Observability hook for {@link SecurityEvent}s (#8) — a rejected
   * cross-origin request, a throttle rejection, a capacity-driven instance
   * eviction/rejection. Log or meter them; the runtime swallows any throw
   * from the hook so it can't affect the request it observes.
   *
   * @example
   * ```ts
   * export default defineConfig({
   *   onSecurityEvent: (e) => logger.warn("rpxd.security", e),
   * });
   * ```
   */
  onSecurityEvent?: (event: SecurityEvent) => void;
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

/**
 * Map the config's instance-registry tuning knobs and security-observability
 * hook onto {@link RpxdHandlerOptions} (§14, #61 capacity caps, #8
 * `SecurityEvent`s). Pulled out of {@link startApp} as its own function so the
 * wiring is unit-testable without standing up a server — `config.instances`
 * spreads straight through (undefined fields keep the handler's defaults) and
 * `onSecurityEvent` rides along.
 *
 * @example
 * ```ts
 * instanceHandlerOptions({ instances: { warmTtlMs: 5000 } });
 * // { warmTtlMs: 5000, onSecurityEvent: undefined }
 * ```
 */
export function instanceHandlerOptions(
  config: RpxdConfig,
): Pick<
  RpxdHandlerOptions,
  | "warmTtlMs"
  | "attachTtlMs"
  | "unattachedTtlMs"
  | "maxUnattachedInstances"
  | "maxInstancesPerSession"
  | "onSecurityEvent"
> {
  return { ...config.instances, onSecurityEvent: config.onSecurityEvent };
}
