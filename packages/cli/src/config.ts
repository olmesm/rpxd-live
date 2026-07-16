/**
 * `rpxd.config.ts` surface (§14): the only non-route file in userland.
 */
import { randomBytes } from "node:crypto";
import { isDev, type RateLimit, type StorageAdapter } from "@rpxd/core";
import type { RouteRegistration, RpxdDiagnosticSink, RpxdHandlerOptions } from "@rpxd/server-bun";

/**
 * A `live()` object as the {@link RpxdConfig.slots} escape hatch accepts it — the
 * structural shape every `live(pattern, propsSchema?).…render()` result carries
 * (ADR 0002). Kept structural (not the full `LiveRoute` generic) so any concrete
 * live object is assignable without generic-variance friction.
 */
export interface SlotModule {
  readonly $live: true;
  readonly path: string;
  readonly def: RouteRegistration["def"];
  readonly props?: RouteRegistration["props"];
}

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
     * Session-cookie attributes (B1, S1). `secure` marks `rpxd_sid` `Secure` —
     * default `true` (accepted on HTTPS and `http://localhost`). Set `false`
     * only for non-localhost HTTP dev. `bun run dev` already defaults it off.
     *
     * `sign` controls HMAC-signing the cookie — default `true` (always
     * signed: an ephemeral secret in dev when `secret` is unset, a configured
     * one required in production). Set `false` to explicitly run unsigned.
     */
    cookie?: { secure?: boolean; sign?: boolean };
    /**
     * Secret for HMAC-signing the `rpxd_sid` cookie (B2, S1) — a forged/unsigned
     * cookie is then rejected as a fresh session. Falls back to
     * `process.env.RPXD_SESSION_SECRET`. Unset in development → an ephemeral
     * in-memory secret (dev/prod fidelity); unset in production → refuses to
     * start (set one, or opt out with `cookie: { sign: false }`).
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
  /**
   * Mount-only live objects the file scan can't see (ADR 0002 item 6, Decision
   * 3): library-shipped slots, or any `live()` object you want registered
   * without a source file in the project tree. **Additive** with the automatic
   * `.rpxd/live.gen.ts` scan — these registrations join the same control-plane
   * mount union as scanned slots and routed pages. Each pattern must still be
   * unique across the whole union (the handler asserts this at boot).
   *
   * @example
   * ```ts
   * import chatSlot from "@acme/chat-slot"; // a shipped live() object
   * export default defineConfig({ slots: [chatSlot] });
   * ```
   */
  slots?: readonly SlotModule[];
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
   * Userland cleanup on graceful shutdown (`SIGTERM`/`SIGINT` under `rpxd
   * start`). Runs after warm snapshots flush and before rpxd closes its own
   * storage — the place to close resources the app owns, e.g. an auth/Prisma
   * client: `onShutdown: () => prisma.$disconnect()`. rpxd closes the storage
   * adapter it created itself.
   */
  onShutdown?: () => void | Promise<void>;
  /**
   * Tuning knobs for the in-memory instance registry (§11) and its
   * connections: warm/attach TTLs, the capacity caps that bound memory under
   * scan floods or a runaway session (#61), each instance's queue-backlog
   * observability (`warnQueueDepth`) plus its opt-in broadcast-backlog cap
   * (`maxBroadcastBacklog`), and the per-connection egress byte budget that
   * bounds what a stalled client can buffer (`maxBufferedBytes`) — see each
   * field's doc on {@link RpxdHandlerOptions} for defaults and behavior.
   * Forwarded straight through; omit a field to keep its handler default.
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
    | "maxBufferedBytes"
    | "warnQueueDepth"
    | "maxBroadcastBacklog"
  >;
  /**
   * Observability diagnostic sink (#73) — every framework diagnostic flows
   * here: a rejected cross-origin request or throttle/capacity rejection
   * (`category: "security"`), a crashed request or WS fault
   * (`category: "request"`), and instance/storage faults. Log or meter them;
   * the runtime swallows any throw from the sink so it can't affect the work
   * it observes. When omitted, diagnostics fall back to the console default sink.
   *
   * @example
   * ```ts
   * export default defineConfig({
   *   onDiagnostic: (d) => logger.log(d.level, "rpxd", d),
   * });
   * ```
   */
  onDiagnostic?: RpxdDiagnosticSink;
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
 * Propagate the resolved session secret into `process.env.RPXD_SESSION_SECRET`
 * (§16, #95): `rsc()` (`packages/rsc/src/server.ts`, react-server graph) signs
 * an RSC field's `$rscTag` and the SSR verifier (`packages/cli/src/ssr.ts`)
 * checks it — separate module graphs in the same process, so this env var is
 * the only channel that carries one shared secret between them. Call this
 * from `createDevServer`/`startApp` right after config resolution and BEFORE
 * the react-server/ssr graphs are set up, so both sides read the same value
 * for the lifetime of the process.
 *
 * Mirrors {@link RpxdHandlerOptions.sessionSecret}'s own resolution (S1, #122):
 * a configured `session.secret` wins; otherwise development mints an
 * ephemeral in-memory secret (so #95 signing/verification exercises the real
 * path in dev too); production gets nothing here (a secret is either
 * configured or the handler's own fail-closed guard refuses to start). Only
 * ever *sets* the env var when the resolved value is non-empty, and never
 * clobbers one already present (`||=`) — an operator-set
 * `RPXD_SESSION_SECRET` (or an earlier call in the same process) always wins.
 *
 * The explicit `cookie: { sign: false }` escape hatch is a no-op here too:
 * that flag means the app deliberately wants the whole B2/#95 secret
 * machinery off (an unsigned sid, `rsc()` shipping unbranded fields), so this
 * must not force a secret into the shared env var behind that choice — doing
 * so would silently turn `rsc()` back on for signing (it also reads this var)
 * and make the SSR verifier reject every field, defeating the opt-out.
 *
 * @example
 * ```ts
 * propagateSessionSecretEnv(config); // before createViteServer / bundle import
 * ```
 */
export function propagateSessionSecretEnv(config: Pick<RpxdConfig, "session">): void {
  if (config.session?.cookie?.sign === false) return; // deliberate unsigned escape hatch (S1) — rsc() stays unbranded too
  const secret = config.session?.secret || (isDev() ? randomBytes(32).toString("hex") : "");
  if (secret) process.env.RPXD_SESSION_SECRET ||= secret;
}

/**
 * Map the config's instance-registry tuning knobs and observability diagnostic
 * sink onto {@link RpxdHandlerOptions} (§14, #61 capacity caps, #73 diagnostic
 * sink). Pulled out of {@link startApp} as its own function so the wiring is
 * unit-testable without standing up a server — `config.instances` spreads
 * straight through (undefined fields keep the handler's defaults) and
 * `onDiagnostic` rides along.
 *
 * @example
 * ```ts
 * instanceHandlerOptions({ instances: { warmTtlMs: 5000 } });
 * // { warmTtlMs: 5000, onDiagnostic: undefined }
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
  | "maxBufferedBytes"
  | "warnQueueDepth"
  | "maxBroadcastBacklog"
  | "onDiagnostic"
> {
  return { ...config.instances, onDiagnostic: config.onDiagnostic };
}

/**
 * Map the config's {@link RpxdConfig.slots} escape-hatch live objects onto
 * {@link RouteRegistration}s for the control-plane mount union (ADR 0002 item
 * 6). Pure — a thin adapter so `startApp`/`createDevServer` can concatenate
 * these with the scanned `.rpxd/live.gen.ts` slots before handing everything to
 * `createRpxdHandler`. Returns `[]` when no config slots are declared.
 *
 * @example
 * ```ts
 * configSlotRegistrations({ slots: [chatSlot] });
 * // → [{ path: "/chat", def: chatSlot.def, props: chatSlot.props }]
 * ```
 */
export function configSlotRegistrations(config: Pick<RpxdConfig, "slots">): RouteRegistration[] {
  return (config.slots ?? []).map((s) => ({ path: s.path, def: s.def, props: s.props }));
}
