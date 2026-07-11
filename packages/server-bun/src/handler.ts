/**
 * The rpxd HTTP runtime (§11, §12): session cookies, instance registry,
 * SSE patch stream, rpc/control endpoints, SSR mount + attach adoption,
 * warm-TTL eviction. Web-standard `Request`/`Response` only — served
 * through any {@link ServerAdapter}.
 */
import {
  decodeBatch,
  defaultDiagnosticSink,
  type Envelope,
  isDev,
  isRedirect,
  isSuperseded,
  type LiveDefinition,
  LiveInstance,
  makeDiagnosticEmit,
  memory,
  type RateLimit,
  type RouteDefinition,
  type RouteMethod,
  type RpcBatch,
  type RpxdDiagnosticSink,
  runPipeline,
  type Stage,
  type StorageAdapter,
  TokenBucket,
} from "@rpxd/core";
import { readSid, SID_COOKIE, signSessionId, timingSafeEqualStr } from "./cookie.ts";
import { matchHttpRoute, matchRoute } from "./match.ts";
import { type AllowedOrigins, originAllowed } from "./origin.ts";

/** One registered route: URL path literal + live definition. */
export interface RouteRegistration {
  path: string;
  // biome-ignore lint/suspicious/noExplicitAny: the handler hosts routes of any state shape
  def: LiveDefinition<any, any, any>;
}

/** One registered HTTP route (`route()`, the routes & auth guide): path + method handlers. */
export interface HttpRouteRegistration {
  path: string;
  def: RouteDefinition;
}

/** Context handed to the `render` hook for SSR (§12). */
export interface RenderContext {
  path: string;
  params: Record<string, string>;
  search: Record<string, string | undefined>;
  state: unknown;
  session: unknown;
  seq: number;
  instance: string;
  attachToken: string;
}

/**
 * The `security`-category diagnostic `type`s the runtime emits (#8, now part of
 * the unified diagnostic sink #73) — a rejected cross-origin request, a throttle
 * rejection, a capacity-driven instance eviction, and a mount rejected at the
 * per-session cap. They reach the app as {@link RpxdDiagnostic}s with
 * `category: "security"` through {@link RpxdHandlerOptions.onDiagnostic}.
 */
type SecurityDiagnosticType = "origin-rejected" | "rate-limited" | "cap-evicted" | "cap-rejected";

/** Options for {@link createRpxdHandler}. */
export interface RpxdHandlerOptions {
  routes: RouteRegistration[];
  /** Server-only HTTP routes (`route()`, the routes & auth guide), matched before SSR. */
  httpRoutes?: HttpRouteRegistration[];
  storage?: StorageAdapter;
  /**
   * Authenticate once at connect (§10). Return the session object; throw to
   * reject with 403. Every reducer sees the result as `ctx.session`.
   */
  authenticate?: (req: Request, ctx: { sid: string }) => unknown | Promise<unknown>;
  /**
   * Cross-origin allowlist for the control plane (`/__rpxd/ws|stream|rpc|control`,
   * #52) and for state-changing `route()` methods (S3). Defaults to
   * **same-origin only** — the cross-site WebSocket-hijack / CSRF defense. A
   * same-origin browser app needs no config; a deliberate cross-origin
   * deployment lists its origins (or passes a predicate). SSR `GET` and
   * `route()`'s `GET`/`HEAD`/`OPTIONS` are never gated — a top-level nav is
   * legitimately cross-site; a `route()`'s state-changing methods can opt out
   * individually with `.crossOrigin()`.
   */
  allowedOrigins?: AllowedOrigins;
  /**
   * Session-cookie attributes (B1). `secure` marks the `rpxd_sid` cookie
   * `Secure` (HTTPS-only) — **default `true`**. Browsers still accept it on
   * `http://localhost` (a secure context) and behind a TLS-terminating proxy;
   * set `false` only for non-localhost HTTP dev, where the sid would otherwise
   * ride cleartext. The dev server / scaffold wire this from `NODE_ENV`.
   */
  cookie?: { secure?: boolean };
  /**
   * Secret for HMAC-signing the `rpxd_sid` cookie (B2). When set, the sid is
   * signed and verified — a forged or unsigned cookie is rejected as a fresh
   * session, closing session fixation and `${sid}:${path}` namespace collision.
   * Falls back to `process.env.RPXD_SESSION_SECRET`. When neither is set the sid
   * is unsigned (pre-B2 behavior) and the handler warns once. Signing is
   * integrity, not confidentiality — pair with the `Secure` cookie for the latter.
   */
  sessionSecret?: string;
  /** SSR renderer (§12). Defaults to a minimal HTML shell embedding the bootstrap payload. */
  render?: (ctx: RenderContext) => Response | Promise<Response>;
  /** Unmatched-URL page (§14 `__404`). Defaults to a plain-text 404. */
  renderNotFound?: (info: { path: string }) => Response | Promise<Response>;
  /** setup/guard/load-rejection / crash page (§10, §14 `__error`). Defaults to plain text. */
  renderError?: (info: { path: string; error: unknown }) => Response | Promise<Response>;
  /**
   * Echo internal error messages in the fallback 500 body (#9). Default `false`
   * — a crash returns a generic `"internal error"` (the full error is logged
   * server-side), so stack/message details never leak to clients. The dev server
   * sets this `true`. Only affects the plain-text fallback, not `renderError`.
   */
  debugErrors?: boolean;
  /** Warm TTL before an unsubscribed instance is snapshotted + evicted (§11). Default 60s. */
  warmTtlMs?: number;
  /** Pending-attach TTL for SSR adoption tokens (§12). Default 10s. */
  attachTtlMs?: number;
  /**
   * Warm TTL for an instance no client has ever attached to (#61). A cookieless
   * GET (crawler, bot, cookie-denying client) warms an instance that is never
   * adopted; it only needs to outlive its attach window, so this defaults to
   * {@link attachTtlMs} rather than the full {@link warmTtlMs}. Bounds how long
   * scan traffic pins un-adopted instances. Must be ≥ `attachTtlMs` or a
   * slow-but-legitimate client can be evicted out of the SSR-adopt fast path.
   */
  unattachedTtlMs?: number;
  /**
   * Hard cap on concurrent never-attached instances (#61). When exceeded, the
   * least-recently-used un-attached instance is evicted (without a snapshot —
   * it was never a real session). Bounds memory under scan floods regardless of
   * traffic shape. `null` disables the cap. Default 1024.
   */
  maxUnattachedInstances?: number | null;
  /**
   * Cap on concurrent instances held for a **single session** (C). A fresh
   * mount at the cap first evicts the session's oldest *idle* (unsubscribed)
   * instance to make room; when every held instance is subscribed to a live
   * connection, the mount is **rejected** — `429` on the HTTP control/GET
   * paths, an error envelope on WS — so joining mounts to an open stream can't
   * pin unbounded instances. Instances a live connection holds are never
   * dropped, and a warm re-mount of an already-held path still succeeds at the
   * cap. `null` disables. Default 32 (a session with that many simultaneous
   * live routes is already pathological).
   */
  maxInstancesPerSession?: number | null;
  /**
   * Opt-in request throttle (#6) — a token bucket per key, keyed by a function
   * you provide so the framework never guesses client identity. `key(req)`
   * returns the throttle key or `null` to skip this request. Over-limit HTTP
   * requests (SSR GET, rpc/control POST) get `429`, checked before
   * `authenticate`; the long-lived SSE stream is exempt (a 429 would break the
   * native EventSource).
   *
   * The key **must derive from a trusted source** — a socket peer address or a
   * proxy-set header. A raw `X-Forwarded-For` is client-spoofable, so an attacker
   * rotating it gets a fresh bucket per request.
   *
   * Buckets are **in-process** (single-node); for multi-node, rate-limit at the
   * proxy/edge. Coverage note: for `transport: ws()` apps this sees only the
   * initial navigation — post-upgrade socket frames don't pass through `fetch`,
   * so rate-limit the upgrade at the proxy. Omit to disable.
   */
  throttle?: { key: (req: Request) => string | null; limit: RateLimit };
  /**
   * The app's diagnostic sink (#73) — the single observability seam for every
   * framework diagnostic: `security` rejections (cross-origin, throttle,
   * capacity), `request` failures, recovered `instance` errors, and `storage`
   * faults. Generalizes the former `onSecurityEvent` hook (#8); filter on
   * `d.category === "security"` for the old behavior. The runtime swallows
   * any throw from the sink so observability can't affect the request, and
   * threads this same sink into every instance and the storage adapter. When
   * omitted, diagnostics fall back to `defaultDiagnosticSink` (console).
   *
   * @example
   * ```ts
   * createRpxdHandler({
   *   routes,
   *   onDiagnostic: (d) => {
   *     if (d.category === "security") metrics.increment(`rpxd.sec.${d.type}`);
   *   },
   * });
   * ```
   */
  onDiagnostic?: RpxdDiagnosticSink;
  defaultRateLimit?: RateLimit;
  /**
   * Max bytes an rpc/control request body (or WS frame) may carry before it's
   * rejected — `413` over HTTP, silent drop over WS (§11 ingress DoS guard).
   * Enforced in the handler so Bun and Node behave identically. Default
   * {@link DEFAULT_MAX_BODY_BYTES} (1 MiB).
   */
  maxBodyBytes?: number;
  /**
   * Max calls a single rpc batch may carry before it's error-acked without
   * running any call (§11 ingress DoS guard). Default 256 (see
   * `DEFAULT_MAX_BATCH_CALLS`). Passed through to every instance.
   */
  maxBatchCalls?: number;
}

/** Default rpc/control body + WS frame cap (§11 ingress DoS guard): 1 MiB. */
export const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;

/**
 * Thrown by {@link readJsonCapped} when a body exceeds the configured cap. The
 * top-level `fetch` maps it to a `413`.
 */
class PayloadTooLargeError extends Error {
  constructor(limit: number) {
    super(`request body exceeds maxBodyBytes (${limit})`);
    this.name = "PayloadTooLargeError";
  }
}

/**
 * Read + JSON-parse a request body, capped at `maxBytes`. `Content-Length` is
 * only a hint (chunked encoding, lying clients), so the real guard streams the
 * body and counts bytes, aborting the read the moment it overflows — the header
 * check is just a cheap fast-path reject. Throws {@link PayloadTooLargeError}
 * on overflow; the caller answers `413`.
 */
async function readJsonCapped(req: Request, maxBytes: number): Promise<unknown> {
  const declared = Number(req.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > maxBytes) throw new PayloadTooLargeError(maxBytes);

  const body = req.body;
  if (!body) {
    const text = await req.text();
    if (text.length === 0) return {};
    if (new TextEncoder().encode(text).byteLength > maxBytes)
      throw new PayloadTooLargeError(maxBytes);
    return JSON.parse(text);
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new PayloadTooLargeError(maxBytes);
    }
    chunks.push(value);
  }
  const buf = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    buf.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(buf));
}

interface InstanceEntry {
  // biome-ignore lint/suspicious/noExplicitAny: registry spans routes of any state shape
  instance: LiveInstance<any, any, any>;
  /** Owning session id — client lookups by instance id must match it (no cross-session access). */
  sid: string;
  /** The pathname this entry is keyed under in its session map (for eviction). */
  key: string;
  path: string;
  params: Record<string, string>;
  attach?: { token: string; expires: number };
  evictTimer?: ReturnType<typeof setTimeout>;
  /**
   * Whether a client has ever subscribed to this instance (#61). Un-attached
   * instances get the short {@link RpxdHandlerOptions.unattachedTtlMs} and count
   * against {@link RpxdHandlerOptions.maxUnattachedInstances}; once attached, an
   * instance earns the full warm TTL and is exempt from the cap.
   */
  everAttached: boolean;
}

/**
 * A live downstream subscriber (one SSE stream or WS socket, §11). Exposes
 * late-mount fan-out so a tier-2 soft reload (§7) can join a fresh instance to
 * an already-open transport, and `releaseInstance` so an abandoned instance is
 * unsubscribed and left to evict.
 */
interface StreamHandle {
  subscribeInstance: (entry: InstanceEntry) => void;
  releaseInstance: (instanceId: string) => void;
  /** Push a synthetic envelope down this stream — for acks that can't come
   * from an instance (e.g. an unknown-instance error ack). */
  send: (env: Envelope) => void;
  cleanup: () => void;
}

/**
 * Encode one envelope as an SSE event (the wire protocol guide framing).
 *
 * @example
 * ```ts
 * encodeSse({ seq: 3, instance: "i1", patches: [] });
 * // "event: env\nid: 3\ndata: {...}\n\n"
 * ```
 */
export function encodeSse(env: Envelope): string {
  return `event: env\nid: ${env.seq}\ndata: ${JSON.stringify(env)}\n\n`;
}

/**
 * Create the rpxd request handler.
 *
 * Endpoints:
 * - `GET /__rpxd/stream` — SSE envelope stream (all session instances)
 * - `POST /__rpxd/rpc` — rpc batch upstream
 * - `POST /__rpxd/control` — `mount` / `resync` / `url` / `release`
 * - any other GET matching a route — SSR mount (§12)
 *
 * @example
 * ```ts
 * const handler = createRpxdHandler({ routes: [{ path: "/", def }] });
 * bunAdapter().serve({ port: 3000, fetch: handler.fetch });
 * ```
 */
export function createRpxdHandler(opts: RpxdHandlerOptions) {
  const storage = opts.storage ?? memory();
  // One wrapped sink (#73) for the handler's own diagnostics, threaded into
  // every instance and the storage bus so the whole runtime reports through it.
  // The wrap catches any throw from the app sink — observability never breaks a
  // request. Falls back to the console sink when no `onDiagnostic` is set.
  const emit = makeDiagnosticEmit(opts.onDiagnostic ?? defaultDiagnosticSink);
  storage.bus.setEmit?.(emit);
  const warmTtlMs = opts.warmTtlMs ?? 60_000;
  const attachTtlMs = opts.attachTtlMs ?? 10_000;
  // Secure session cookie by default (B1) — opt out only for non-localhost HTTP dev.
  const cookieSecure = opts.cookie?.secure ?? true;
  // HMAC-signed sid (B2): unforgeable when a secret is set. Falls back to env;
  // unset or empty → unsigned + a one-time warning (the sid stays forgeable).
  // `||` (not `??`) collapses an empty-string secret to `undefined` so the
  // write, read, and warning paths all agree it means "unsigned".
  const sessionSecret = opts.sessionSecret || process.env.RPXD_SESSION_SECRET || undefined;
  if (!sessionSecret) {
    // Secure by default (S1): an unsigned sid is forgeable, so refuse to boot
    // outside development rather than silently downgrade in prod/staging/unset.
    if (!isDev()) {
      throw new Error(
        "rpxd: refusing to start — the session cookie is unsigned outside development. " +
          "Set RPXD_SESSION_SECRET (32+ random bytes) in production, or NODE_ENV=development for local dev.",
      );
    }
    warnUnsignedSid(); // development only: keep the existing one-time warning
  }
  const debugErrors = opts.debugErrors ?? false; // #9: hide internal errors from clients by default
  /** Throttle buckets, keyed by the app's `throttle.key(req)` (#6, in-process). */
  const throttleBuckets = new Map<string, TokenBucket>();
  /** Bound on distinct throttle keys held, so the limiter can't itself leak memory (#6). */
  const MAX_THROTTLE_KEYS = 50_000;
  // Un-attached instances only need to outlive their attach window (#61).
  const unattachedTtlMs = opts.unattachedTtlMs ?? attachTtlMs;
  const maxUnattachedInstances =
    opts.maxUnattachedInstances === undefined ? 1024 : opts.maxUnattachedInstances;
  const maxInstancesPerSession =
    opts.maxInstancesPerSession === undefined ? 32 : opts.maxInstancesPerSession;
  // Ingress body/frame cap (§11 DoS guard): rpc/control 413s, WS frame drops.
  const maxBodyBytes = opts.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  /** sessionId → instanceKey → entry */
  const sessions = new Map<string, Map<string, InstanceEntry>>();
  const byInstanceId = new Map<string, InstanceEntry>();
  /**
   * Never-attached instances in LRU order (#61) — insertion order is recency;
   * a warm reuse re-inserts to bump. Bounds the un-adopted set under scan
   * floods: exceeding `maxUnattachedInstances` sheds the oldest (front).
   */
  const unattached = new Set<InstanceEntry>();

  /**
   * Resolve an instance id for a client request, but only if it belongs to the
   * requesting session. `byInstanceId` is a global registry, so an unchecked
   * lookup would let any session drive any instance by id (IDOR).
   */
  function ownedInstance(instanceId: string | undefined, sid: string): InstanceEntry | undefined {
    if (!instanceId) return undefined;
    const entry = byInstanceId.get(instanceId);
    return entry && entry.sid === sid ? entry : undefined;
  }

  /**
   * One ack per batch, even when the instance is gone (a §2 invariant): a
   * batch naming an unknown/unowned instance (stale id after eviction or a
   * redeploy) is error-acked so the client's pending call rejects instead of
   * hanging forever. `seq: 0` deliberately lands in the client's stale-seq
   * branch, which still settles acks.
   */
  function unknownInstanceAck(instanceId: string, rpcId: string): Envelope {
    return {
      seq: 0,
      instance: instanceId,
      rpcId,
      error: { name: "UnknownInstanceError", message: "unknown or expired instance" },
    };
  }

  /** What {@link acceptBatch} did with an inbound rpc batch. */
  type BatchOutcome = "accepted" | "unknown-instance" | "malformed";

  /**
   * The guarded batch-dispatch boundary (channel pipeline increment 2, closing
   * #110 at the boundary and #65 WS parity): the SINGLE funnel both `handleRpc`
   * (HTTP) and the WS `message()` `"calls"` branch call to accept an inbound
   * rpc batch. Never throws or rejects, and every outcome is delivered — either
   * through `send` (an error/unknown-instance ack) or the returned
   * {@link BatchOutcome}, which each caller maps to its own transport status.
   *
   * `raw` is genuinely untrusted wire data (a parsed JSON body or WS frame),
   * so it's decoded with {@link decodeBatch} rather than cast — a caller can
   * no longer crash on `raw.calls` being `null`/non-array/malformed.
   */
  function acceptBatch(raw: unknown, sid: string, send: (env: Envelope) => void): BatchOutcome {
    const decoded = decodeBatch(raw);
    if (!decoded.ok) {
      emit({
        category: "request",
        type: "rpc-decode-failed",
        level: "warn",
        detail: { reason: decoded.reason, instance: decoded.instance },
      });
      // Only ack when there's a real pending call to correlate it to: both
      // `rpcId` and `instance` must have survived as strings off the wire,
      // AND that instance must actually belong to this session — otherwise
      // there's nothing legitimate to reject into, and no client waiting on
      // this exact rpcId to settle.
      if (decoded.rpcId && decoded.instance && ownedInstance(decoded.instance, sid)) {
        send({
          seq: 0,
          instance: decoded.instance,
          rpcId: decoded.rpcId,
          error: { name: "ProtocolError", message: `malformed batch: ${decoded.reason}` },
        });
      }
      return "malformed";
    }

    const entry = ownedInstance(decoded.batch.instance, sid);
    if (!entry) {
      send(unknownInstanceAck(decoded.batch.instance, decoded.batch.rpcId));
      return "unknown-instance";
    }

    // Belt-and-braces: `handleBatch` is total on its own (increment 1), but a
    // fire-and-forget call must never be able to reject unhandled.
    void entry.instance.handleBatch(decoded.batch).catch((e) => {
      emit({ category: "instance", type: "batch-execute-threw", level: "error", error: e });
    });
    return "accepted";
  }

  /** sessionId → client stream id → live SSE subscriber (§7 tier-2 late mount). */
  const streamRegistry = new Map<string, Map<string, StreamHandle>>();
  let disposed = false;

  /**
   * Client-safe error body (#9): the real message only in `debugErrors` mode,
   * else a generic fallback — internals never leak to clients by default.
   * Shared by the 403 (auth) and 500 (crash) paths and the WS upgrade.
   */
  function safeErrorMessage(e: unknown, fallback: string): string {
    return debugErrors && e instanceof Error ? e.message : fallback;
  }

  /** Fire a `security`-category event (#8) through the unified sink (#73). The
   * `emit` wrapper swallows any throw from the app sink — observability must
   * never affect the request it observes. */
  function emitSecurity(type: SecurityDiagnosticType, detail?: Record<string, unknown>): void {
    emit({ category: "security", type, level: "warn", detail });
  }

  function registerStream(sid: string, streamId: string, handle: StreamHandle): void {
    let m = streamRegistry.get(sid);
    if (!m) {
      m = new Map();
      streamRegistry.set(sid, m);
    }
    m.set(streamId, handle);
  }

  function unregisterStream(sid: string, streamId: string): void {
    const m = streamRegistry.get(sid);
    if (!m) return;
    m.delete(streamId);
    if (m.size === 0) streamRegistry.delete(sid);
  }

  function sessionOf(req: Request): { sid: string; isNew: boolean } {
    return readSid(req, sessionSecret); // verify signature (B2) when a secret is set
  }

  function withSession(res: Response, sid: string, isNew: boolean): Response {
    if (isNew) {
      // `Secure` by default (B1): browsers accept it on HTTPS and on
      // `http://localhost` (a secure context); only non-localhost HTTP dev needs
      // the `cookie.secure: false` opt-out. `HttpOnly` + `SameSite=Lax` always.
      // The value is HMAC-signed when a secret is set (B2).
      const value = sessionSecret ? signSessionId(sid, sessionSecret) : sid;
      const attrs = `Path=/; HttpOnly; SameSite=Lax${cookieSecure ? "; Secure" : ""}`;
      res.headers.append("set-cookie", `${SID_COOKIE}=${value}; ${attrs}`);
    }
    return res;
  }

  function entriesFor(sid: string): Map<string, InstanceEntry> {
    let map = sessions.get(sid);
    if (!map) {
      map = new Map();
      sessions.set(sid, map);
    }
    return map;
  }

  // Reconcile an instance to a URL (§7) — `guard` then `load`. Runs on every
  // page load, fresh or warm: the URL is the query key, so a full-page load (or
  // Link mount) must reconcile to its search, not just the first `setup`.
  // `guard` (§10) is awaited so a deny `throw redirect` 302s *before* we serve —
  // the redirect propagates to the caller. SSR sequencing (§12): the first
  // document carries state through the loader's first patch (`loadForRender`),
  // then the rest streams — a synchronous projection renders immediately (fast
  // TTFB), an await-before-first-patch loader blocks the paint until its data
  // lands (crawlable). A redirect thrown before the first patch propagates to a
  // 302 / soft-nav; one thrown after is mid-stream and swallowed — use `guard`.
  async function reconcileUrl(
    def: RouteRegistration["def"],
    instance: InstanceEntry["instance"],
    search: Record<string, string | undefined>,
  ): Promise<void> {
    try {
      if (def.guard) await instance.authorize(search); // deny → throw redirect → 302
    } catch (e) {
      // A newer URL superseded this guard run mid-flight: the winning run owns
      // the outcome. Bail without loading — falling through would load a URL
      // this run never authorized (a swallowed deny would leak its data).
      if (isSuperseded(e)) return;
      throw e;
    }
    if (!def.load) return;
    await instance.loadForRender(search);
  }

  /**
   * Run `guard` for a not-yet-created instance (#8) — the mount stage that gates
   * access *before* `setup`, so a denied principal never triggers `setup` (which
   * wires pubsub subscriptions) or any allocation. Mirrors
   * {@link LiveInstance.authorize}'s invocation against the request's freshly
   * authenticated `session`; a deny (`throw redirect`) propagates. New mounts
   * only — a live instance re-guards on URL change via `authorize` (latest-wins).
   */
  async function runGuard(
    def: RouteRegistration["def"],
    params: Record<string, string>,
    session: unknown,
    search: Record<string, string | undefined>,
  ): Promise<void> {
    const guard = def.guard;
    if (!guard) return;
    await guard({ params, search }, { params, session, signal: new AbortController().signal });
  }

  /**
   * The mount-stage runner (#8): build a fresh instance through its ordered
   * lifecycle stages — `guard → setup → load`. Guard runs first so a denied
   * request allocates nothing; a throw from `load` after `setup` disposes the
   * half-built instance (without a snapshot) so it can't orphan the pubsub
   * subscriptions `setup` wired. Redirects and errors propagate to the caller.
   */
  async function buildInstance(
    sid: string,
    pathname: string,
    sessionData: unknown,
    route: RouteRegistration,
    match: { path: string; params: Record<string, string> },
    search: Record<string, string | undefined>,
  ): Promise<InstanceEntry["instance"]> {
    if (route.def.guard) {
      await runGuard(route.def, match.params, sessionData, search); // deny → throw, nothing built
    }
    const instance = await LiveInstance.create({
      id: crypto.randomUUID(),
      def: route.def,
      params: match.params,
      session: (sessionData as Record<string, unknown>) ?? {},
      storage,
      storageKey: `${sid}:${pathname}`,
      defaultRateLimit: opts.defaultRateLimit,
      maxBatchCalls: opts.maxBatchCalls,
      emit,
    });
    try {
      if (route.def.load) await instance.loadForRender(search);
    } catch (e) {
      // Load bailed out (e.g. a loader redirect) → tear down so we don't orphan
      // the subscriptions `setup` wired. `dispose(false)` skips the final
      // snapshot; the one `create` wrote at this key stays (bounded to one, and
      // overwritten by the next successful mount) — session continuity, not a leak.
      await instance.dispose(false);
      throw e;
    }
    return instance;
  }

  async function mountInstance(
    sid: string,
    sessionData: unknown,
    pathname: string,
    search: Record<string, string | undefined>,
  ): Promise<InstanceEntry> {
    const entries = entriesFor(sid);
    const existing = entries.get(pathname);
    if (existing) {
      const sameSession =
        JSON.stringify(existing.instance.session ?? {}) === JSON.stringify(sessionData ?? {});
      if (sameSession) {
        if (existing.evictTimer) {
          clearTimeout(existing.evictTimer);
          existing.evictTimer = undefined;
        }
        // Warm reuse counts as recent use — bump it to most-recent in the LRU
        // (#61) so a live-but-un-adopted instance isn't shed before a colder one.
        if (unattached.delete(existing)) unattached.add(existing);
        // Reconcile the warm instance to this load's URL (§7).
        const route = opts.routes.find((r) => r.path === existing.path);
        if (route) await reconcileUrl(route.def, existing.instance, search);
        return existing;
      }
      // The authenticated session changed (login/logout, §10): the principal —
      // and any session-scoped state `setup` computed — is stale. Evict, drop
      // the snapshot, and re-create fresh below rather than adopt the warm
      // instance (§12), which would render the old principal.
      if (existing.evictTimer) clearTimeout(existing.evictTimer);
      entries.delete(pathname);
      byInstanceId.delete(existing.instance.id);
      unattached.delete(existing);
      await existing.instance.dispose();
      await storage.delete(`${sid}:${pathname}`);
    }

    // Hard per-session ceiling (C): reserve a slot *before* building. Idle
    // (unsubscribed) instances are shed to make room; when a live connection
    // holds every slot, the fresh mount is rejected — otherwise a loop of
    // stream-joined mounts pins unbounded subscribed instances past the cap.
    if (maxInstancesPerSession != null) {
      const m = sessions.get(sid);
      if (m && m.size >= maxInstancesPerSession) {
        shedIdleInstances(m, maxInstancesPerSession);
        if (m.size >= maxInstancesPerSession) {
          emitSecurity("cap-rejected", { sid, path: pathname });
          throw new SessionCapError();
        }
      }
    }

    const match = matchRoute(
      opts.routes.map((r) => r.path),
      pathname,
    );
    if (!match) throw new NotFoundError(pathname);
    const route = opts.routes.find((r) => r.path === match.path) as RouteRegistration;

    // Guard → setup → load, with cleanup on throw (#8). A deny or loader redirect
    // throws out before the instance is registered below.
    const instance = await buildInstance(sid, pathname, sessionData, route, match, search);

    // A concurrent mount for the same key can register while we awaited
    // `buildInstance` (both passed the warm-reuse check above). Two entries
    // under one key would let the loser's eviction delete the winner's slot
    // and snapshot row — dispose the just-built loser and adopt the winner.
    const winner = entriesFor(sid).get(pathname);
    if (winner) {
      await instance.dispose(false); // no snapshot — the winner owns `${sid}:${pathname}`
      return winner;
    }

    const entry: InstanceEntry = {
      instance,
      sid,
      key: pathname,
      path: match.path,
      params: match.params,
      attach: { token: crypto.randomUUID(), expires: Date.now() + attachTtlMs },
      everAttached: false,
    };
    // Re-resolve the session slice rather than reusing `entries` captured at the
    // top: an eviction timer that fired during the awaits above may have pruned
    // an empty slice out of `sessions` (#61), orphaning the captured reference.
    // `entriesFor` re-attaches (or recreates) the canonical slice.
    entriesFor(sid).set(pathname, entry);
    byInstanceId.set(instance.id, entry);
    unattached.add(entry);
    enforceUnattachedCap(entry);
    enforcePerSessionCap(sid, entry);
    scheduleEvictionIfIdle(entry);
    return entry;
  }

  /**
   * Remove an entry from every registry and dispose it, pruning its session
   * slice if it empties (#61). A never-adopted instance drops its snapshot and
   * storage row (a cookieless scan — persisting is waste); an adopted one gets
   * a final write-through snapshot (§11). Shared by every eviction site.
   */
  function evictEntry(entry: InstanceEntry): void {
    if (entry.evictTimer) {
      clearTimeout(entry.evictTimer);
      entry.evictTimer = undefined;
    }
    const m = sessions.get(entry.sid);
    // Identity-guard the key-based deletes: a raced twin that lost the
    // registry must not clobber the winner's slot or `${sid}:${key}` row.
    const owner = m?.get(entry.key) === entry;
    if (m && owner) {
      m.delete(entry.key);
      if (m.size === 0) sessions.delete(entry.sid);
    }
    byInstanceId.delete(entry.instance.id);
    unattached.delete(entry);
    if (entry.everAttached) {
      void entry.instance.dispose();
    } else {
      void entry.instance
        .dispose(false)
        .then(() => (owner ? storage.delete(`${entry.sid}:${entry.key}`) : undefined))
        .catch(() => {});
    }
  }

  /**
   * Shed least-recently-used never-attached instances until the set is within
   * {@link RpxdHandlerOptions.maxUnattachedInstances} (#61). `keep` is the entry
   * we just registered — never evict it, even if the cap is 0/1.
   */
  function enforceUnattachedCap(keep: InstanceEntry): void {
    if (maxUnattachedInstances == null) return;
    for (const entry of unattached) {
      if (unattached.size <= maxUnattachedInstances) break;
      if (entry === keep) continue;
      emitSecurity("cap-evicted", { reason: "unattached", sid: entry.sid, path: entry.key });
      evictEntry(entry);
    }
  }

  /**
   * Shed a session's oldest *idle* (unsubscribed) instances until fewer than
   * `limit` remain (C). Skips `keep` and any instance a live connection still
   * holds — an instance is never dropped out from under a subscriber.
   */
  function shedIdleInstances(
    m: Map<string, InstanceEntry>,
    limit: number,
    keep?: InstanceEntry,
  ): void {
    for (const entry of [...m.values()]) {
      if (m.size < limit) break;
      if (entry === keep || entry.instance.subscriberCount > 0) continue;
      emitSecurity("cap-evicted", { reason: "per-session", sid: entry.sid, path: entry.key });
      evictEntry(entry);
    }
  }

  /**
   * Cap instances held for one session (C): shed idle instances until within
   * {@link RpxdHandlerOptions.maxInstancesPerSession}. Backstops the pre-build
   * slot reservation in `mountInstance` when concurrent mounts race past it.
   */
  function enforcePerSessionCap(sid: string, keep: InstanceEntry): void {
    if (maxInstancesPerSession == null) return;
    const m = sessions.get(sid);
    if (!m || m.size <= maxInstancesPerSession) return;
    shedIdleInstances(m, maxInstancesPerSession + 1, keep);
  }

  /**
   * Mark an instance attached (#61) — a client has subscribed. It leaves the
   * un-attached LRU set (exempt from the cap) and earns the full warm TTL.
   */
  function markAttached(entry: InstanceEntry): void {
    entry.everAttached = true;
    unattached.delete(entry);
  }

  function scheduleEvictionIfIdle(entry: InstanceEntry): void {
    if (entry.instance.subscriberCount > 0 || entry.evictTimer || disposed) return;
    // A never-attached instance only needs to outlive its attach window (#61);
    // once adopted, it earns the full warm TTL. Either way, keep a
    // pending-attach instance alive at least until its token expires.
    const baseTtl = entry.everAttached ? warmTtlMs : unattachedTtlMs;
    const graceMs = Math.max(baseTtl, (entry.attach?.expires ?? 0) - Date.now());
    entry.evictTimer = setTimeout(() => {
      if (entry.instance.subscriberCount > 0) return;
      evictEntry(entry);
    }, graceMs);
  }

  /**
   * Subscribe every session instance to `send` (shared by SSE and WS, §11 —
   * the envelope is transport-agnostic). Returns a cleanup that also
   * re-arms eviction timers.
   */
  function subscribeSession(
    sid: string,
    send: (env: Envelope) => void,
    attach?: { token: string | null; seq: number },
  ): StreamHandle {
    const entries = entriesFor(sid);
    /** instanceId → this subscriber's unsub, so a single instance is joined once. */
    const unsubs = new Map<string, () => void>();

    const subscribeInstance = (entry: InstanceEntry, initial = false) => {
      // Idempotent: a warm instance already on this stream must not double-join
      // (tier-2 re-mount of a still-live path, §7).
      if (unsubs.has(entry.instance.id)) return;
      if (entry.evictTimer) {
        clearTimeout(entry.evictTimer);
        entry.evictTimer = undefined;
      }
      markAttached(entry); // a client has subscribed — earns the warm TTL (#61)
      unsubs.set(entry.instance.id, entry.instance.addListener(send));
      const adopted =
        initial &&
        attach?.token != null &&
        entry.attach !== undefined &&
        timingSafeEqualStr(entry.attach.token, attach.token) &&
        entry.attach.expires > Date.now() &&
        attach.seq === entry.instance.seq;
      if (adopted) {
        // SSR adoption (§12): resume from seq — no full snapshot needed.
        entry.attach = undefined;
      } else {
        entry.instance.resync();
      }
    };

    const releaseInstance = (instanceId: string) => {
      // Tier-2 soft reload (§7): the client abandoned this instance. Drop this
      // stream's listener and let the warm timer evict it if nothing else holds it.
      const unsub = unsubs.get(instanceId);
      if (!unsub) return;
      unsub();
      unsubs.delete(instanceId);
      const entry = byInstanceId.get(instanceId);
      if (entry) scheduleEvictionIfIdle(entry);
    };

    for (const entry of entries.values()) subscribeInstance(entry, true);

    return {
      subscribeInstance: (entry) => subscribeInstance(entry, false),
      releaseInstance,
      send,
      cleanup: () => {
        // Re-arm from the live registry, not the connect-time `entries`
        // capture: empty-slice pruning can orphan that map mid-connection, and
        // a later mount registered in the fresh slice would never get a timer.
        for (const [instanceId, unsub] of unsubs) {
          unsub();
          const entry = byInstanceId.get(instanceId);
          if (entry) scheduleEvictionIfIdle(entry);
        }
      },
    };
  }

  async function handleStream(req: Request, sid: string): Promise<Response> {
    const url = new URL(req.url);
    const attachToken = url.searchParams.get("attach");
    const attachSeq = Number(url.searchParams.get("seq") ?? "-1");
    // Client-owned stream id (§7): control `mount`/`release` name it to join or
    // drop instances on this exact stream (multi-tab safe). Absent for legacy /
    // one-shot streams — a random id keeps the registry keyed uniformly.
    const streamId = url.searchParams.get("stream") ?? crypto.randomUUID();

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        controller.enqueue(encoder.encode("retry: 1000\n\n"));
        const handle = subscribeSession(
          sid,
          (env) => {
            try {
              controller.enqueue(encoder.encode(encodeSse(env)));
            } catch {
              // stream already closed; eviction handles cleanup
            }
          },
          { token: attachToken, seq: attachSeq },
        );
        registerStream(sid, streamId, handle);
        req.signal.addEventListener("abort", () => {
          unregisterStream(sid, streamId);
          handle.cleanup();
          try {
            controller.close();
          } catch {
            // already closed
          }
        });
      },
    });

    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      },
    });
  }

  // WIRE CONTRACT — the control-plane messages (mount/resync/url/release) and
  // the `?attach&seq` adoption below are documented in
  // docs-site/src/content/docs/concepts/wire-protocol.md and pinned by
  // packages/core/test/protocol-conformance.test.ts. Change all three together.
  async function handleControl(req: Request, sid: string, sessionData: unknown) {
    const msg = (await readJsonCapped(req, maxBodyBytes)) as
      | { type: "mount"; path: string; search?: Record<string, string>; stream?: string }
      | { type: "resync"; instance: string }
      | { type: "release"; instance: string; stream: string }
      | { type: "url"; instance: string; search: Record<string, string> };

    if (msg.type === "mount") {
      let entry: InstanceEntry;
      try {
        entry = await mountInstance(sid, sessionData, msg.path, msg.search ?? {});
      } catch (e) {
        // `setup`/`guard` threw redirect() (§10): tell the client to navigate rather
        // than instantiate. A GET load handles this as a 302 (see fetch catch).
        if (isRedirect(e)) return Response.json({ redirect: e.location });
        throw e;
      }
      // Tier-2 soft reload (§7): a `stream` id joins the fresh instance to that
      // already-open SSE stream so its snapshot flows without a reconnect.
      if (msg.stream) streamRegistry.get(sid)?.get(msg.stream)?.subscribeInstance(entry);
      return Response.json({
        instance: entry.instance.id,
        seq: entry.instance.seq,
        path: entry.path,
        params: entry.params,
      });
    }
    if (msg.type === "release") {
      // Abandoned by a tier-2 forward nav (§7): drop it from that stream so it
      // evicts. Idempotent — an unknown instance/stream is a no-op.
      streamRegistry.get(sid)?.get(msg.stream)?.releaseInstance(msg.instance);
      return new Response(null, { status: 204 });
    }
    const entry = ownedInstance(msg.instance, sid);
    if (!entry) return new Response("unknown instance", { status: 404 });
    if (msg.type === "resync") {
      entry.instance.resync();
      return new Response(null, { status: 204 });
    }
    // Runtime URL change (nav.patch, §7): reconcile guard+load. A guard deny
    // → redirect JSON for the client to soft-nav (§10).
    const route = opts.routes.find((r) => r.path === entry.path);
    try {
      if (route) await reconcileUrl(route.def, entry.instance, msg.search);
    } catch (e) {
      if (isRedirect(e)) return Response.json({ redirect: e.location });
      throw e;
    }
    return new Response(null, { status: 204 });
  }

  async function handleRpc(req: Request, sid: string): Promise<Response> {
    // Every outcome's ack (unknown-instance, malformed, or a real rpc ack)
    // rides the session's stream(s), not this response — this is just the
    // transport-level acknowledgement. `acceptBatch` is the shared guarded
    // dispatch boundary (channel pipeline increment 2, #110/#65) this and the
    // WS `message()` `"calls"` branch both funnel through.
    const send = (env: Envelope) => {
      for (const h of streamRegistry.get(sid)?.values() ?? []) h.send(env);
    };
    const outcome = acceptBatch(await readJsonCapped(req, maxBodyBytes), sid, send);
    switch (outcome) {
      case "accepted":
        return new Response(null, { status: 202 });
      case "unknown-instance":
        return new Response("unknown instance", { status: 404 });
      case "malformed":
        return new Response("malformed batch", { status: 400 });
    }
  }

  function defaultRender(ctx: RenderContext): Response {
    const bootstrap = JSON.stringify({
      instance: ctx.instance,
      seq: ctx.seq,
      attachToken: ctx.attachToken,
      snapshot: { state: ctx.state, session: ctx.session },
      path: ctx.path,
      params: ctx.params,
    });
    const html = `<!doctype html>
<html><head><meta charset="utf-8"><title>rpxd</title></head>
<body><div id="root"></div>
<script id="__rpxd" type="application/json">${bootstrap.replaceAll("</", "<\\/")}</script>
</body></html>`;
    return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
  }

  // ---------------------------------------------------------------------
  // Channel A (#75): `fetch`'s HTTP request→response ladder as named stages
  // over `runPipeline` (@rpxd/core) — origin gate → throttle → authenticate
  // → dispatch, in that fixed order, exactly as the flat ladder ran it. Each
  // stage below is the *exact* branch body moved verbatim out of the old
  // inline `fetch`; only the shape (`{ done }` / `{ next }`) changed.
  // `dispatchStage` never resolves its own error path — a redirect/NotFound/
  // SessionCap/PayloadTooLarge/crash is a genuine throw, and `mapRequestError`
  // (the old inline `catch`, verbatim) is the pipeline's terminal `onError`.
  // ---------------------------------------------------------------------

  /** Context threaded stage-to-stage; `sessionData` only exists post-auth. */
  interface RequestCtx {
    req: Request;
    url: URL;
    sid: string;
    isNew: boolean;
    sessionData: unknown;
  }

  /**
   * Origin gate (#52): the control plane is same-origin by default. Runs
   * before authenticate so the auth hook is never a cross-site side-channel.
   * SSR GET and route() handlers are deliberately exempt (see dispatchStage).
   */
  const originStage: Stage<RequestCtx, Response> = (ctx) => {
    const isControlPlane =
      ctx.url.pathname === "/__rpxd/stream" ||
      ctx.url.pathname === "/__rpxd/rpc" ||
      ctx.url.pathname === "/__rpxd/control";
    if (isControlPlane && !originAllowed(ctx.req, opts.allowedOrigins)) {
      emitSecurity("origin-rejected", {
        origin: ctx.req.headers.get("origin"),
        path: ctx.url.pathname,
      });
      return { done: new Response("forbidden origin", { status: 403 }) };
    }
    return { next: ctx };
  };

  /**
   * Throttle (#6): a per-key token bucket over the HTTP request paths (SSR
   * GET, rpc/control POST), before authenticate so a flood can't amplify
   * auth/mount work. The long-lived SSE stream is exempt — a native
   * EventSource can't reconnect after a non-200, so a 429 there would
   * permanently kill the live channel. `key(req) === null` skips a request.
   */
  const throttleStage: Stage<RequestCtx, Response> = (ctx) => {
    if (opts.throttle && ctx.url.pathname !== "/__rpxd/stream") {
      const k = opts.throttle.key(ctx.req);
      if (k !== null) {
        let bucket = throttleBuckets.get(k);
        if (!bucket) {
          // Bound the bucket map so the throttle can't itself leak memory under
          // a key-rotating flood — drop the oldest (a reset bucket starts full,
          // i.e. lenient, never a bypass of an active limit).
          if (throttleBuckets.size >= MAX_THROTTLE_KEYS) {
            const oldest = throttleBuckets.keys().next().value;
            if (oldest !== undefined) throttleBuckets.delete(oldest);
          }
          bucket = new TokenBucket(opts.throttle.limit);
          throttleBuckets.set(k, bucket);
        }
        if (!bucket.take()) {
          emitSecurity("rate-limited", { key: k, path: ctx.url.pathname });
          return { done: new Response("rate limited", { status: 429 }) };
        }
      }
    }
    return { next: ctx };
  };

  /**
   * Authenticate (§10): runs once per request; skipped entirely (sessionData
   * stays `{}`) when `opts.authenticate` is unset, exactly as today. A throw
   * is a 403 — auth rejections are often intentional (logged-out) so this
   * doesn't log the noise, but hides any unexpected internal message (#9).
   */
  const authStage: Stage<RequestCtx, Response> = async (ctx) => {
    if (!opts.authenticate) return { next: ctx };
    try {
      const sessionData = await opts.authenticate(ctx.req, { sid: ctx.sid });
      return { next: { ...ctx, sessionData } };
    } catch (e) {
      return { done: new Response(safeErrorMessage(e, "forbidden"), { status: 403 }) };
    }
  };

  /**
   * Dispatch (§11/§12/§14): stream/rpc/control/httpRoutes/SSR-GET/404,
   * verbatim from the old inline `try` body — including exactly which
   * branches are `withSession(...)`-wrapped. Deliberately does not catch: a
   * redirect/NotFound/SessionCap/PayloadTooLarge/crash from `handleControl`,
   * `mountInstance`, `reconcileUrl`, a route handler, or `render` propagates
   * out as a throw for `mapRequestError` to handle.
   */
  const dispatchStage: Stage<RequestCtx, Response> = async (ctx) => {
    const { req, url, sid, isNew, sessionData } = ctx;
    if (url.pathname === "/__rpxd/stream") {
      return { done: withSession(await handleStream(req, sid), sid, isNew) };
    }
    if (url.pathname === "/__rpxd/rpc" && req.method === "POST") {
      return { done: withSession(await handleRpc(req, sid), sid, isNew) };
    }
    if (url.pathname === "/__rpxd/control" && req.method === "POST") {
      return { done: withSession(await handleControl(req, sid, sessionData), sid, isNew) };
    }
    // HTTP routes (`route()`) — matched before SSR, any method (§ docs/
    // routes-and-auth.md). The handler owns its own response/cookies; we
    // still carry the sid cookie on new sessions.
    if (opts.httpRoutes && opts.httpRoutes.length > 0) {
      const hit = matchHttpRoute(
        opts.httpRoutes.map((r) => r.path),
        url.pathname,
      );
      if (hit) {
        const reg = opts.httpRoutes.find((r) => r.path === hit.path) as HttpRouteRegistration;
        const method = req.method.toUpperCase() as RouteMethod;
        // CSRF (S3): state-changing route() methods are same-origin by default —
        // GET/HEAD/OPTIONS stay exempt (top-level nav / CORS preflight is legitimately
        // cross-site). `.crossOrigin()` opts a route back out (public webhooks).
        const safeMethod = method === "GET" || method === "HEAD" || method === "OPTIONS";
        if (!safeMethod && !reg.def.crossOrigin && !originAllowed(req, opts.allowedOrigins)) {
          emitSecurity("origin-rejected", {
            origin: req.headers.get("origin"),
            path: url.pathname,
          });
          return {
            done: withSession(new Response("forbidden origin", { status: 403 }), sid, isNew),
          };
        }
        const fn = reg.def.handlers[method] ?? reg.def.handlers.ALL;
        if (!fn) {
          return {
            done: withSession(new Response("method not allowed", { status: 405 }), sid, isNew),
          };
        }
        const res = await fn(req, { params: hit.params, session: sessionData, sid });
        return { done: withSession(res, sid, isNew) };
      }
    }
    if (req.method === "GET") {
      // SSR (§12): setup+guard+load run during SSR; the connection adopts the warm
      // instance via the attach token.
      const search: Record<string, string> = {};
      url.searchParams.forEach((v, k) => {
        search[k] = v;
      });
      const entry = await mountInstance(sid, sessionData, url.pathname, search);
      const renderCtx: RenderContext = {
        path: entry.path,
        params: entry.params,
        search,
        state: entry.instance.state,
        session: entry.instance.session,
        seq: entry.instance.seq,
        instance: entry.instance.id,
        attachToken: entry.attach?.token ?? "",
      };
      const render = opts.render ?? defaultRender;
      return { done: withSession(await render(renderCtx), sid, isNew) };
    }
    return { done: new Response("not found", { status: 404 }) };
  };

  /**
   * The pipeline's terminal error stage (`runPipeline`'s `onError`) — the old
   * inline `catch (e)` block, verbatim, reading `ctx.url`/`ctx.sid`/
   * `ctx.isNew` in place of the closed-over `url`/`sid`/`isNew` locals it used
   * to read.
   */
  async function mapRequestError(err: unknown, ctx: RequestCtx): Promise<Response> {
    const { url, sid, isNew } = ctx;
    // Oversized rpc/control body (§11 ingress DoS guard): reject before it
    // reaches a handler.
    if (err instanceof PayloadTooLargeError) {
      return withSession(new Response(err.message, { status: 413 }), sid, isNew);
    }
    // `setup`/`guard`/`load` threw redirect() (§10): a full page load follows a real 302.
    if (isRedirect(err)) {
      return withSession(
        new Response(null, { status: err.status, headers: { location: err.location } }),
        sid,
        isNew,
      );
    }
    // The session is at its instance cap with every slot subscribed (C) —
    // shed load like the throttle does, on both the control and GET paths.
    if (err instanceof SessionCapError) {
      return withSession(new Response(err.message, { status: 429 }), sid, isNew);
    }
    if (err instanceof NotFoundError) {
      if (opts.renderNotFound) {
        return withSession(await opts.renderNotFound({ path: url.pathname }), sid, isNew);
      }
      return new Response("not found", { status: 404 });
    }
    // A real crash (not a redirect/not-found): report it server-side
    // regardless of how it's rendered (#9), so it's never silently swallowed.
    emit({
      category: "request",
      type: "request-failed",
      level: "error",
      error: err,
      detail: { path: url.pathname },
    });
    // setup/load rejection → error route (§10). The app's page owns disclosure.
    if (opts.renderError) {
      return withSession(await opts.renderError({ path: url.pathname, error: err }), sid, isNew);
    }
    // Fallback: a generic body so error/stack messages don't leak (unless debugErrors).
    return new Response(safeErrorMessage(err, "internal error"), { status: 500 });
  }

  return {
    async fetch(req: Request): Promise<Response> {
      const url = new URL(req.url);
      const { sid, isNew } = sessionOf(req);
      return runPipeline<RequestCtx, Response>(
        { req, url, sid, isNew, sessionData: {} },
        [originStage, throttleStage, authStage, dispatchStage],
        (err, ctx) => mapRequestError(err, ctx),
      );
    },

    /** Stop timers and dispose every instance (final snapshots included). */
    async dispose(): Promise<void> {
      disposed = true;
      const all = [...sessions.values()].flatMap((m) => [...m.values()]);
      sessions.clear();
      byInstanceId.clear();
      streamRegistry.clear();
      unattached.clear();
      for (const entry of all) {
        if (entry.evictTimer) clearTimeout(entry.evictTimer);
      }
      await Promise.all(all.map((e) => e.instance.dispose()));
    },

    /**
     * Open a duplex session socket (§11 `transport: ws()`): envelopes flow
     * out through `send`; rpc batches and control messages come in through
     * `message`. Same protocol as SSE — only the framing differs.
     */
    socket(
      sid: string,
      sessionData: unknown,
      send: (env: Envelope) => void,
      attach?: { token: string | null; seq: number },
    ): { message(raw: string): Promise<void>; close(): void } {
      const { subscribeInstance, releaseInstance, cleanup } = subscribeSession(sid, send, attach);
      return {
        async message(raw: string): Promise<void> {
          // Ingress DoS guard (§11): a WS frame carries no Content-Length, so
          // cap the raw string before JSON.parse amplifies it. Drop silently —
          // there's no rpcId to ack until it parses, and no legit client sends
          // an over-cap frame.
          if (raw.length > maxBodyBytes) return;
          let msg:
            | RpcBatch
            | {
                type: "resync" | "url" | "mount" | "release";
                instance?: string;
                path?: string;
                search?: Record<string, string>;
              };
          try {
            msg = JSON.parse(raw);
          } catch {
            // An unparseable frame (garbled client, transport corruption): report
            // it through the sink from here rather than letting it escape to
            // ws.ts's generic catch, which logs but can't tell the client
            // anything and carries no `reason` to distinguish it from any other
            // failure mode.
            emit({
              category: "request",
              type: "ws-message-failed",
              level: "warn",
              detail: { reason: "unparseable-frame" },
            });
            return;
          }
          if ("calls" in msg) {
            // The guarded dispatch boundary (channel pipeline increment 2,
            // #110/#65) — same funnel `handleRpc` (HTTP) uses. The socket's own
            // `send` is the sink for the malformed/unknown-instance acks.
            acceptBatch(msg, sid, send);
            return;
          }
          if (msg.type === "mount" && msg.path) {
            // The socket *is* the stream (§11): join the mount to it directly.
            // `subscribeInstance` is idempotent, so a warm re-mount is a no-op.
            try {
              const entry = await mountInstance(sid, sessionData, msg.path, msg.search ?? {});
              subscribeInstance(entry);
            } catch (e) {
              // Answer denials on the socket (mirroring the `url` branch) —
              // thrown out, they'd otherwise die in the transport's generic
              // catch and the client waits forever.
              const warm = sessions.get(sid)?.get(msg.path);
              if (isRedirect(e)) {
                send({
                  seq: warm?.instance.seq ?? 0,
                  instance: warm?.instance.id ?? "",
                  redirect: e.location,
                });
              } else if (e instanceof SessionCapError) {
                send({
                  seq: 0,
                  instance: "",
                  error: { name: e.name, message: e.message },
                });
              } else if (e instanceof NotFoundError) {
                // #65 WS mount parity: mounting an unregistered path 404s over
                // SSE/control (`handleControl` lets it propagate to the `fetch`
                // catch); over WS it must answer the socket the same way rather
                // than silently dying in the transport's generic catch.
                send({
                  seq: 0,
                  instance: "",
                  error: { name: e.name, message: e.message },
                });
              } else {
                // A genuinely unexpected error: keep `message()` total (no
                // outcome may escape unhandled) by reporting it through the
                // sink instead of throwing.
                emit({ category: "request", type: "ws-message-failed", level: "error", error: e });
              }
            }
            return;
          }
          if (msg.type === "release" && msg.instance) {
            releaseInstance(msg.instance); // tier-2 forward nav (§7)
            return;
          }
          const entry = ownedInstance(msg.instance, sid);
          if (!entry) return;
          if (msg.type === "resync") entry.instance.resync();
          if (msg.type === "url" && msg.search) {
            // Runtime URL change over WS (§7): reconcile guard+load; a guard deny
            // → a redirect envelope for the client to soft-nav (§10).
            const route = opts.routes.find((r) => r.path === entry.path);
            try {
              if (route) await reconcileUrl(route.def, entry.instance, msg.search);
            } catch (e) {
              if (isRedirect(e)) {
                send({
                  seq: entry.instance.seq,
                  instance: entry.instance.id,
                  redirect: e.location,
                });
              } else throw e;
            }
          }
        },
        close: cleanup,
      };
    },

    /**
     * Swap a route's live definition (§15 reducer HMR): updates the registry
     * and every mounted instance of the route — state is preserved.
     */
    updateRoute(path: string, def: RouteRegistration["def"]): void {
      const registration = opts.routes.find((r) => r.path === path);
      if (registration) registration.def = def;
      else opts.routes.push({ path, def });
      for (const entry of byInstanceId.values()) {
        if (entry.path === path) entry.instance.replaceDef(def);
      }
    },

    /**
     * Whether a request passes the control-plane origin policy (#52). Shared
     * with the WS transport so the SSE/POST and upgrade paths enforce one
     * source of truth.
     */
    checkOrigin(req: Request): boolean {
      return originAllowed(req, opts.allowedOrigins);
    },

    /**
     * Resolve a request to its session id, verifying the signed cookie (B2).
     * Shared with the WS transport so SSE/POST and the upgrade resolve the same
     * sid from the same cookie.
     */
    resolveSid(req: Request): { sid: string; isNew: boolean } {
      return readSid(req, sessionSecret);
    },

    /**
     * Client-safe error body (#9), shared with the WS transport so the upgrade's
     * 403 hides internal messages the same way SSE/POST do.
     */
    safeErrorMessage(e: unknown, fallback: string): string {
      return safeErrorMessage(e, fallback);
    },

    /** The unified event sink (#73) — shared with the WS transport so upgrade
     * rejections and socket-message faults report through the same seam as
     * SSE/POST. Already wrapped, so a throw from the app sink is swallowed. */
    emit,

    /** Test/introspection hook: number of live instances across sessions. */
    get instanceCount(): number {
      return byInstanceId.size;
    },

    /** Test/introspection hook: number of session slices held (#61 — should not grow unboundedly). */
    get sessionCount(): number {
      return sessions.size;
    },
  };
}

class NotFoundError extends Error {
  constructor(pathname: string) {
    super(`No route matches ${pathname}`);
    this.name = "NotFoundError";
  }
}

/**
 * A fresh mount would exceed `maxInstancesPerSession` with every held slot
 * subscribed (C) — mapped to `429` on HTTP, an error envelope on WS.
 */
class SessionCapError extends Error {
  constructor() {
    super("session instance cap exceeded");
    this.name = "SessionCapError";
  }
}

let unsignedSidWarned = false;
/** Warn once per process that the session cookie is unsigned (B2). */
function warnUnsignedSid(): void {
  if (unsignedSidWarned) return;
  unsignedSidWarned = true;
  console.warn(
    "[rpxd] no session secret set — the rpxd_sid cookie is unsigned and forgeable. " +
      "Set `sessionSecret` (or the RPXD_SESSION_SECRET env var) to sign it (B2).",
  );
}
