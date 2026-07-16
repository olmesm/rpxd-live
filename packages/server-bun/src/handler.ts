/**
 * The rpxd HTTP runtime (§11, §12): session cookies, instance registry,
 * SSE patch stream, rpc/control endpoints, SSR mount + attach adoption,
 * warm-TTL eviction. Web-standard `Request`/`Response` only — served
 * through any {@link ServerAdapter}.
 */

import { randomBytes } from "node:crypto";
import {
  canonicalProps,
  decodeBatch,
  decodeProps,
  defaultDiagnosticSink,
  type Envelope,
  isDev,
  isRedirect,
  isSuperseded,
  type LiveDefinition,
  LiveInstance,
  type MountBatchResult,
  makeDiagnosticEmit,
  memory,
  type RateLimit,
  type RouteDefinition,
  type RouteMethod,
  type RpcBatch,
  type RpxdDiagnosticSink,
  runPipeline,
  type Stage,
  type StandardSchemaV1,
  type StorageAdapter,
  TokenBucket,
  ValidationError,
  validateInput,
} from "@rpxd/core";
import { readSid, SID_COOKIE, signSessionId, timingSafeEqualStr } from "./cookie.ts";
import { matchHttpRoute, matchRoute } from "./match.ts";
import { type AllowedOrigins, originAllowed } from "./origin.ts";

/** One registered route: URL path literal + live definition. */
export interface RouteRegistration {
  path: string;
  // biome-ignore lint/suspicious/noExplicitAny: the handler hosts routes of any state/props shape
  def: LiveDefinition<any, any, any, any>;
  /**
   * The props schema declared via `live(pattern, propsSchema?)` (ADR 0002),
   * carried through from `LiveRoute.props`. When present, the page GET path
   * decodes the `?query` string ({@link decodeProps}) and validates it against
   * this schema **before** `guard`+`load` — `?limit=20` reaches the loader as
   * the number `20`. When absent, props stay the raw string record (back-compat).
   */
  props?: StandardSchemaV1<unknown, unknown>;
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
  /**
   * The props record for this load — the raw `?query` string values, or the
   * decoded+validated props (numbers, booleans, objects) when the route
   * declares a props schema (ADR 0002 §3). Same record the loader saw.
   */
  search: Record<string, unknown>;
  state: unknown;
  session: unknown;
  seq: number;
  instance: string;
  attachToken: string;
}

/**
 * The `security`-category diagnostic `type`s the runtime emits (#8, now part of
 * the unified diagnostic sink #73) — a rejected cross-origin request, a throttle
 * rejection, a capacity-driven instance eviction, a mount rejected at the
 * per-session cap, a connection killed for exceeding the egress byte budget, a
 * mount refused over the per-session state byte budget, and a mount refused by
 * the per-session mount throttle (the last two are ADR 0002 item 14). They reach
 * the app as {@link RpxdDiagnostic}s with `category: "security"` through
 * {@link RpxdHandlerOptions.onDiagnostic}.
 */
type SecurityDiagnosticType =
  | "origin-rejected"
  | "rate-limited"
  | "cap-evicted"
  | "cap-rejected"
  | "stream-overflow"
  | "session-budget-exceeded"
  | "mount-throttled";

/** Options for {@link createRpxdHandler}. */
export interface RpxdHandlerOptions {
  /**
   * Router-served live objects: the pages a browser GET / SSR mounts and the
   * client router navigates. Only these are served over a top-level `GET` (§12);
   * the control-plane `mount` message also matches them (a routed page is a
   * mountable slot by construction — Decision 2).
   */
  routes: RouteRegistration[];
  /**
   * Mount-only live objects (ADR 0002 item 6): exported `live()` objects the
   * control-plane `mount` message can address but a browser GET / SSR **cannot**
   * — requesting a slot pattern as a page is a `404`. The control plane matches
   * `mount` against the **union** of {@link routes} and these, so a slot flows
   * through the exact same warm-reuse / session-cap / eviction path as a page;
   * only the address space differs. Every pattern must be unique across the
   * union (a page and a slot claiming one pattern is a boot-time error) — the
   * scan/config wiring enforces this, and {@link createRpxdHandler} asserts it.
   *
   * @example
   * ```ts
   * createRpxdHandler({
   *   routes: [{ path: "/org/$orgId/board", def: boardDef }],
   *   slots: [{ path: "/chat", def: chatDef, props: chatPropsSchema }],
   * });
   * ```
   */
  slots?: RouteRegistration[];
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
   * Session-cookie attributes (B1, S1). `secure` marks the `rpxd_sid` cookie
   * `Secure` (HTTPS-only) — **default `true`**. Browsers still accept it on
   * `http://localhost` (a secure context) and behind a TLS-terminating proxy;
   * set `false` only for non-localhost HTTP dev, where the sid would otherwise
   * ride cleartext. The dev server / scaffold wire this from `NODE_ENV`.
   *
   * `sign` controls HMAC-signing the `rpxd_sid` cookie — **default `true`**:
   * the sid is always signed, in development (an ephemeral in-memory secret
   * when none is configured) and production (a configured
   * {@link RpxdHandlerOptions.sessionSecret} required) alike, so the signing
   * path is never dev/prod-divergent. Set `false` to explicitly run
   * unsigned — the sid becomes forgeable — for the rare app that manages its
   * own session integrity and deliberately doesn't want rpxd to sign.
   */
  cookie?: { secure?: boolean; sign?: boolean };
  /**
   * Secret for HMAC-signing the `rpxd_sid` cookie (B2, S1). When set, the sid is
   * signed and verified — a forged or unsigned cookie is rejected as a fresh
   * session, closing session fixation and `${sid}:${path}` namespace collision.
   * Falls back to `process.env.RPXD_SESSION_SECRET`. When neither is set,
   * signing still happens by default: development gets an ephemeral
   * process-lifetime secret (dev/prod fidelity — signing, and RSC branding
   * #95, run exactly as in prod), while production refuses to start (set
   * `RPXD_SESSION_SECRET`, or opt out deliberately with `cookie: { sign: false
   * }`). Signing is integrity, not confidentiality — pair with the `Secure`
   * cookie for the latter.
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
   * Soft per-session **state byte budget** (ADR 0002 item 14, Decision 6): the
   * running sum of each held instance's serialized state size
   * ({@link LiveInstance.stateBytes}). Where {@link maxInstancesPerSession} caps
   * *structure* (a thousand tiny instances is an attack bytes can't see), this
   * caps *substance* (one ballooning instance is an attack counts can't see).
   *
   * Enforcement is **soft and at the mount gate only**: a NEW mount for a session
   * already over budget first tries to shed the session's idle (unsubscribed)
   * instances — reclaiming their bytes without dropping anyone's live
   * connection — and, if that can't get under budget, refuses the new mount
   * (`429` on HTTP control / SSR GET, an error envelope on WS, with a
   * `security`/`session-budget-exceeded` diagnostic). It **never** rejects a
   * flush or rpc on an existing instance and **never** evicts a subscribed one —
   * over-budget just means "no more mounts until space frees", degrading a slot
   * to its `fallback` rather than corrupting a live object.
   *
   * **`null` (the default) disables it.** No number is baked in: a surprise
   * budget shipped in a patch release would break apps whose legitimate state
   * happens to exceed it. Opt in with a value comfortably above your largest
   * expected per-session working set — a few MiB is a reasonable starting point
   * for a slot-heavy app, sized from the sum of a page's slots' snapshots.
   *
   * @example
   * ```ts
   * createRpxdHandler({ routes, maxSessionStateBytes: 4 * 1024 * 1024 });
   * ```
   */
  maxSessionStateBytes?: number | null;
  /**
   * Per-session **mount throttle** (ADR 0002 item 14, Decision 6): a token bucket
   * over the control-plane `mount` / `mount-batch` messages (both HTTP and WS),
   * so a client stuck in a remount loop degrades to `429` → `fallback` instead of
   * pinning the server in mount work. Costed **per entry** — a `mount-batch` of N
   * spends N tokens (refused wholesale if fewer than N remain), so a batch can't
   * bypass the limit. Exceeded → `429` (HTTP) / an error envelope (WS) with a
   * `security`/`mount-throttled` diagnostic; existing instances' rpcs and flushes
   * are untouched (only *new* mounts are gated). SSR page `GET`s go through the
   * separate {@link throttle} instead — this guards the slot control plane.
   *
   * **Default ON**, sized generously ({@link DEFAULT_MOUNT_RATE_LIMIT}) so a
   * realistic navigation pattern (~1 mount per interaction) never trips it; only
   * a pathological loop does. `null` disables. Buckets are in-process
   * (single-node); for multi-node, throttle at the proxy/edge.
   *
   * @example
   * ```ts
   * createRpxdHandler({ routes, mountRateLimit: { capacity: 96, refillPerSec: 32 } });
   * ```
   */
  mountRateLimit?: RateLimit | null;
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
  /**
   * Egress byte budget per connection (§11 slow-consumer guard). Envelope
   * emission never blocks the instance, so a client that reads slower than its
   * instance produces buffers the difference in server memory — unbounded
   * without this cap. When a connection's unsent bytes exceed the budget it is
   * killed (the SSE stream errored with its buffer discarded; the WS socket
   * closed) with a `security`/`stream-overflow` diagnostic, and the client's
   * normal reconnect recovers via a full-snapshot `resync`. Because that resync
   * rides one envelope, the budget must comfortably exceed the largest full
   * state snapshot or a reconnecting client re-trips it forever. Healthy
   * connections hold ~0 buffered bytes, so only laggards ever approach it.
   * Default {@link DEFAULT_MAX_BUFFERED_BYTES} (8 MiB); `null` disables.
   *
   * Enforcement is bounded by what the runtime lets us observe:
   * - **WS** — enforced continuously via the socket's `getBufferedAmount`
   *   (Bun natively; the Node adapter maps the `ws` package's
   *   `bufferedAmount`). Sockets without the seam are never falsely killed.
   * - **SSE on the Node adapter** — enforced continuously: its drain-aware
   *   write loop propagates socket backpressure into the stream queue, where
   *   `desiredSize` sees it.
   * - **SSE on Bun** — enforced only for bursts that land before the runtime
   *   drains the queue (e.g. a connect-time snapshot over budget). Bun
   *   buffers streamed responses internally without honoring `desiredSize`
   *   (verified against Bun 1.3.11: with a TCP-stalled client, Bun drains
   *   40+ MiB from a push stream — and accepts it unblocked in direct
   *   mode — while `desiredSize` never drops; no upstream ticket exists as
   *   of that version, and Bun's streams doc claims otherwise). Gradual lag
   *   is invisible there until Bun exposes response backpressure — prefer
   *   `transport: ws()` or a proxy-level idle policy for laggard protection
   *   on Bun.
   */
  maxBufferedBytes?: number | null;
  /**
   * Depth at which an instance's single queue — the one serialization point
   * for patchState flushes, loader writes, rpc commits/acks, snapshot writes,
   * AND broadcast `on` handler runs — is considered backlogged. Fires one
   * `instance/queue-backlog` diagnostic per backlog episode (re-arms once
   * depth drains back under this value); pure observability, nothing is ever
   * dropped or rejected because of it. Defaults to `maxBatchCalls * 2`.
   * Passed through to every instance.
   */
  warnQueueDepth?: number;
  /**
   * Opt-in cap on outstanding broadcast/event (`on` handler) runs per
   * instance — the *only* enqueue this can drop. The instance's queue is
   * shared with state-critical work (patchState/load/rpc/snapshot), and a
   * blanket queue-depth cap would reject that too — unsafe. So this counts
   * and caps only broadcast/event enqueues: past the cap, an excess broadcast
   * is dropped (never enqueued) with an `instance/broadcast-dropped`
   * diagnostic, while every other queued write still lands. Default
   * `undefined` (unbounded — today's behavior). Passed through to every
   * instance.
   */
  maxBroadcastBacklog?: number;
}

/** Default rpc/control body + WS frame cap (§11 ingress DoS guard): 1 MiB. */
export const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;

/**
 * Default per-session mount throttle (ADR 0002 item 14): capacity 96, refill
 * 32/s. Sized so realistic navigation (~1 mount per interaction) never trips it
 * and even a full {@link MAX_MOUNT_BATCH} (64) batch fits inside one burst, while
 * a remount loop still degrades to `429` → `fallback`. See
 * {@link RpxdHandlerOptions.mountRateLimit}.
 */
export const DEFAULT_MOUNT_RATE_LIMIT: RateLimit = { capacity: 96, refillPerSec: 32 };

/**
 * Batch size at which a `mount-batch` earns the dev **fan-out doctrine**
 * diagnostic (ADR 0002 item 11, Decision 6): a page coalescing more than this
 * many slot mounts in one tick is almost always mapping rows to slots — the
 * antipattern the "Aggregates, not rows" doctrine warns against (a list of
 * slots = a missing aggregate). Fires an `instance/slot-fanout-high` diagnostic
 * (dev only, via {@link isDev}), several steps before the hard
 * {@link RpxdHandlerOptions.maxInstancesPerSession} wall at 32. Purely advisory —
 * nothing is rejected; the batch mounts normally.
 */
export const SLOT_FANOUT_ADVICE = 10;

/**
 * Hard sanity cap on `mount-batch` length (ADR 0002 item 11): an explicit bound
 * on top of the natural {@link DEFAULT_MAX_BODY_BYTES} body limit, so a single
 * frame can't ask the server to `Promise.all` an unbounded number of mounts
 * (each mount runs `guard`/`setup`/`load`). An over-cap batch is rejected `413`
 * with nothing mounted. Well above any real page's sibling-slot count — the
 * dev {@link SLOT_FANOUT_ADVICE} diagnostic fires long before this.
 */
export const MAX_MOUNT_BATCH = 64;

/**
 * Default per-connection egress byte budget (§11 slow-consumer guard): 8 MiB —
 * 8× the {@link DEFAULT_MAX_BODY_BYTES} ingress cap, so it comfortably clears
 * any realistic full-snapshot envelope (see
 * {@link RpxdHandlerOptions.maxBufferedBytes} for why it must) while bounding
 * what a stalled client can pin in server memory.
 */
export const DEFAULT_MAX_BUFFERED_BYTES = 8 * 1024 * 1024;

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
  /**
   * Canonical serialization ({@link canonicalProps}) of the props most recently
   * reconciled onto this instance — set after the initial `buildInstance` load
   * and after every winning `reconcileUrl` (ADR 0002 item 8). The warm-mount
   * dedup skips `load` when an incoming reconcile's props canonicalize to this
   * exact string (and the instance is live, not snapshot-restored). A
   * superseded/failed reconcile leaves it untouched so the next attempt reloads.
   */
  lastProps?: string;
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
  // Union uniqueness (ADR 0002 Decision 2): the control plane matches `mount`
  // against routes ∪ slots by pattern, so a pattern claimed by two *different*
  // live objects is ambiguous — refuse to start rather than silently pick one.
  // Same-pattern-same-object (the identical registration in both lists) is
  // instance sharing, not a conflict, so only distinct objects collide. Fail
  // closed at construction, style-matched to the session-secret refusal below.
  {
    const byPath = new Map<string, RouteRegistration>();
    for (const reg of opts.slots ? [...opts.routes, ...opts.slots] : opts.routes) {
      const prior = byPath.get(reg.path);
      if (prior && prior !== reg) {
        throw new Error(
          `rpxd: refusing to start — duplicate live() pattern ${JSON.stringify(reg.path)} ` +
            "registered by two different live objects across routes ∪ slots. Each pattern " +
            "must be unique across the control-plane mount union (ADR 0002 Decision 2).",
        );
      }
      byPath.set(reg.path, reg);
    }
  }
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
  // Sign by default (S1): the only way to run unsigned is the explicit escape
  // hatch below, so an unsigned sid is never an accidental default.
  const explicitUnsigned = opts.cookie?.sign === false;
  // HMAC-signed sid (B2): unforgeable when a secret is set. `||` (not `??`)
  // collapses an empty-string secret to `undefined` so it's treated the same
  // as "no secret configured" below, rather than signing with an empty key.
  // explicitUnsigned short-circuits this to `undefined` unconditionally (#95):
  // since the CLI now propagates a resolved secret into
  // process.env.RPXD_SESSION_SECRET so rsc()/the SSR verifier can share it
  // (§16), a secret can be "available" via that env var (or the `sessionSecret`
  // option) even for an app that deliberately asked for `cookie.sign:false` —
  // the escape hatch must still mean "never signed", not "signed if something
  // happens to be configured".
  let sessionSecret = explicitUnsigned
    ? undefined
    : opts.sessionSecret || process.env.RPXD_SESSION_SECRET || undefined;
  if (!sessionSecret && !explicitUnsigned) {
    if (isDev()) {
      // Dev/prod fidelity: no configured secret in dev → an ephemeral in-memory
      // secret so signing (and RSC branding, #95) runs exactly as in prod. It
      // changes per process start — a scaffolded app's .env (S2) gives a stable
      // one; a bare handler just gets fresh sessions across restarts.
      sessionSecret = randomBytes(32).toString("hex");
      warnEphemeralDevSecret();
    } else {
      // Secure by default (S1): an unsigned sid is forgeable, so refuse to boot
      // outside development rather than silently downgrade in prod/staging/unset.
      throw new Error(
        "rpxd: refusing to start — no session-cookie signing secret. " +
          "Set RPXD_SESSION_SECRET (32+ random bytes) in production, " +
          "NODE_ENV=development for local dev (ephemeral secret), " +
          "or cookie: { sign: false } to run unsigned deliberately.",
      );
    }
  }
  // explicitUnsigned → sessionSecret stays undefined → the existing unsigned read/write path runs.
  if (explicitUnsigned) warnUnsignedSid();
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
  // Soft per-session state byte budget (ADR 0002 item 14): `null` (default)
  // disables — no number is baked in, so a patch release can't surprise-break an
  // app whose legitimate state exceeds an invented default. Read only at the
  // mount gate, so a disabled budget costs nothing on the hot path.
  const maxSessionStateBytes = opts.maxSessionStateBytes ?? null;
  // Per-session mount throttle (ADR 0002 item 14): default ON, `null` disables.
  const mountRateLimit =
    opts.mountRateLimit === undefined ? DEFAULT_MOUNT_RATE_LIMIT : opts.mountRateLimit;
  /** Mount-throttle buckets, keyed by session id (in-process, single-node). */
  const mountThrottleBuckets = new Map<string, TokenBucket>();
  // Ingress body/frame cap (§11 DoS guard): rpc/control 413s, WS frame drops.
  const maxBodyBytes = opts.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  // Egress budget (§11 slow-consumer guard): `null` disables, undefined → default.
  const maxBufferedBytes =
    opts.maxBufferedBytes === undefined ? DEFAULT_MAX_BUFFERED_BYTES : opts.maxBufferedBytes;
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

  /**
   * The registrations the control plane can mount (ADR 0002 item 6): routed
   * pages ∪ mount-only slots. Recomputed per call so a reducer-HMR
   * {@link updateRoute} push into `opts.routes` is reflected. GET/SSR never uses
   * this (it passes `opts.routes` alone), so a slot pattern stays unservable as
   * a page. Returns `opts.routes` verbatim when there are no slots (the common
   * case) to avoid an allocation.
   */
  function mountable(): RouteRegistration[] {
    return opts.slots && opts.slots.length > 0 ? [...opts.routes, ...opts.slots] : opts.routes;
  }

  /**
   * Find the registration a live instance was mounted from, across the mount
   * union (ADR 0002 item 6) — a slot instance's def is in `opts.slots`, not
   * `opts.routes`, so a runtime `url` reconcile must look in both.
   */
  function registrationFor(path: string): RouteRegistration | undefined {
    return mountable().find((r) => r.path === path);
  }

  // Reconcile an instance to a URL (§7) — `guard` then `load`. Runs on every
  // page load, fresh or warm: the URL is the query key, so a full-page load (or
  // Link mount) must reconcile to its props, not just the first `setup`.
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
    props: Record<string, unknown>,
    // ADR 0002 item 8: skip the `load` half (guard always runs) when the caller
    // has determined the props are unchanged since the last winning reconcile
    // and the instance is live. Never weakens `guard` — authorization freshness.
    skipLoad = false,
  ): Promise<boolean> {
    try {
      if (def.guard) await instance.authorize(props); // deny → throw redirect → 302
    } catch (e) {
      // A newer URL superseded this guard run mid-flight: the winning run owns
      // the outcome. Bail without loading — falling through would load a URL
      // this run never authorized (a swallowed deny would leak its data). Report
      // "not reconciled" so the dedup key isn't advanced to a superseded run's props.
      if (isSuperseded(e)) return false;
      throw e;
    }
    if (!def.load || skipLoad) return true; // no loader / deduped skip → reconciled
    return instance.loadForRender(props); // false when a newer run superseded this load
  }

  /**
   * Warm-mount dedup (ADR 0002 item 8): reconcile a **live in-memory** instance
   * to `props`, ALWAYS rerunning `guard` (authorization freshness is never
   * weakened, §10) but SKIPPING `load` when `props` canonicalize
   * ({@link canonicalProps}) to the entry's last winning reconcile AND the
   * instance wasn't just cold-woken from a snapshot (a restored instance may
   * have missed broadcasts, §9, so it always reloads). The single place the
   * skip rule lives — the warm-reuse branch of {@link mountInstance} and the
   * `url` control message (HTTP + WS) all funnel through it, so the multi-tab
   * storm (a second tab re-mounting a slot-bearing page) re-guards without
   * re-running every slot's `load`. `entry.lastProps` advances only on a run
   * that actually reconciled; a guard deny (`throw redirect`) propagates to the
   * caller exactly as an un-deduped reconcile would, and a superseded/failed
   * run leaves the key untouched so the next attempt reloads.
   */
  async function reconcileEntry(
    entry: InstanceEntry,
    def: RouteRegistration["def"],
    props: Record<string, unknown>,
  ): Promise<void> {
    const canonical = canonicalProps(props);
    const skipLoad = canonical === entry.lastProps && !entry.instance.restoredFromSnapshot;
    const reconciled = await reconcileUrl(def, entry.instance, props, skipLoad);
    if (reconciled) entry.lastProps = canonical;
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
    props: Record<string, unknown>,
  ): Promise<void> {
    const guard = def.guard;
    if (!guard) return;
    await guard({ params, props }, { params, session, signal: new AbortController().signal });
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
    search: Record<string, unknown>,
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
      warnQueueDepth: opts.warnQueueDepth,
      maxBroadcastBacklog: opts.maxBroadcastBacklog,
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

  /**
   * Resolve a page GET's `?query` string into the props record the loader sees
   * (ADR 0002 §3). When the matched route declares a props schema, the query is
   * decoded (per-value try-`JSON.parse`, {@link decodeProps}) and validated
   * against it — `?limit=20` becomes the number `20` — **before** any mount, so
   * untrusted input never reaches `guard`/`load` unvalidated and an invalid
   * value throws {@link ValidationError} (mapped to 422) with nothing built. A
   * schema-less route keeps the raw string record, byte-identical to pre-ADR
   * behavior (last value wins on a repeated key, matching `mountInstance`).
   */
  async function resolveGetProps(
    pathname: string,
    query: URLSearchParams,
  ): Promise<Record<string, unknown>> {
    const match = matchRoute(
      opts.routes.map((r) => r.path),
      pathname,
    );
    const schema = match ? opts.routes.find((r) => r.path === match.path)?.props : undefined;
    if (!schema) {
      const raw: Record<string, string> = {};
      query.forEach((v, k) => {
        raw[k] = v;
      });
      return raw;
    }
    // Validated output flows onward as props; a violation throws before mount.
    // A props schema is a record schema, so its output is a props record.
    return (await validateInput(
      schema,
      decodeProps(query),
      `props ${match?.path ?? pathname}`,
    )) as Record<string, unknown>;
  }

  /**
   * Resolve a control-plane `mount`'s `props` into the record `guard`+`load`
   * see (ADR 0002 item 6). Unlike a page GET, control-plane props are already a
   * JSON value model (values arrive typed off the wire — no {@link decodeProps}),
   * so when the matched registration declares a props schema this only validates
   * `raw` against it — **before** any mount, so untrusted input never reaches
   * `guard`/`load` and an invalid value throws {@link ValidationError} (mapped to
   * 422 over HTTP control, an error envelope over WS) with nothing built. A
   * schema-less registration passes `raw` through verbatim (back-compat).
   * `registrations` is the mount union so a slot's schema is found too.
   */
  async function resolveMountProps(
    pathname: string,
    raw: Record<string, unknown>,
    registrations: RouteRegistration[],
  ): Promise<Record<string, unknown>> {
    const match = matchRoute(
      registrations.map((r) => r.path),
      pathname,
    );
    const schema = match ? registrations.find((r) => r.path === match.path)?.props : undefined;
    if (!schema) return raw;
    return (await validateInput(schema, raw, `props ${match?.path ?? pathname}`)) as Record<
      string,
      unknown
    >;
  }

  /**
   * Validate a `url` props patch (ADR 0002 item 7) against the live instance's
   * registration props schema **before** the reconcile, so untrusted input never
   * reaches `guard`/`load`. Unlike {@link resolveMountProps}, the registration is
   * already resolved — a `url` patch names a bound instance whose `entry.path` is
   * the exact pattern ({@link registrationFor}), so no `matchRoute` is needed.
   * Like `mount`, the patch payload is a JSON value model (no {@link decodeProps}
   * — the values arrive typed off the control plane). A schema-less registration
   * passes `raw` through verbatim (byte-identical to pre-ADR `nav.patch`). An
   * invalid value throws {@link ValidationError} (mapped to 422 over HTTP, an
   * instance-scoped error envelope over WS) — nothing reconciles.
   */
  async function resolveUrlProps(
    route: RouteRegistration,
    raw: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    if (!route.props) return raw;
    return (await validateInput(route.props, raw, `props ${route.path}`)) as Record<
      string,
      unknown
    >;
  }

  async function mountInstance(
    sid: string,
    sessionData: unknown,
    pathname: string,
    search: Record<string, unknown>,
    // The registrations to match `pathname` against (ADR 0002 item 6): GET/SSR
    // passes `opts.routes` (pages only, so a slot pattern 404s as a page); the
    // control plane passes {@link mountable} (routes ∪ slots). Everything else —
    // warm reuse, session cap, raced-twin dispose, eviction — is identical, so
    // the two address spaces share one lifecycle (Decision 2, stop-signal #1).
    registrations: RouteRegistration[] = opts.routes,
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
        // Reconcile the warm instance to this load's URL (§7), with the item-8
        // dedup: re-guard always, re-load only on a props change. Look across
        // the caller's registration set so a slot instance finds its own def.
        const route = registrations.find((r) => r.path === existing.path);
        if (route) await reconcileEntry(existing, route.def, search);
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
          // Doctrine-worded (ADR 0002 Decision 6, "Aggregates, not rows"): the
          // cap isn't a memory limit to be raised, it's structure enforcement.
          // A session at 32 live instances is almost always a page mapping rows
          // to slots — the diagnostic names the doctrine so the fix is legible.
          emitSecurity("cap-rejected", {
            sid,
            path: pathname,
            cap: maxInstancesPerSession,
            hint:
              "a page mapping a list into slots should own the collection as one " +
              "live object — see 'Aggregates, not rows'",
          });
          throw new SessionCapError();
        }
      }
    }

    // Soft per-session state byte budget (ADR 0002 item 14, Decision 6): where
    // the cap bounds instance *count*, this bounds their total *bytes*. Measured
    // on the ALREADY-HELD instances (the new one isn't built yet), so it refuses
    // once a session is over budget rather than pre-sizing an unbuilt mount —
    // soft by design. Shed idle instances first (their bytes are reclaimable
    // without dropping a live connection); if that can't get under budget, refuse
    // the NEW mount — never a flush/rpc on an existing instance, never a
    // subscribed one's eviction. Enforced at the mount gate only.
    if (maxSessionStateBytes != null) {
      const m = sessions.get(sid);
      if (m && sessionStateBytes(m) >= maxSessionStateBytes) {
        shedIdleForBudget(m, maxSessionStateBytes);
        const bytes = sessionStateBytes(m);
        if (bytes >= maxSessionStateBytes) {
          emitSecurity("session-budget-exceeded", {
            sid,
            path: pathname,
            bytes,
            budget: maxSessionStateBytes,
          });
          throw new SessionBudgetError();
        }
      }
    }

    const match = matchRoute(
      registrations.map((r) => r.path),
      pathname,
    );
    if (!match) throw new NotFoundError(pathname);
    const route = registrations.find((r) => r.path === match.path) as RouteRegistration;

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
      // The initial `buildInstance` load reconciled these props (ADR 0002 item
      // 8): seed the dedup key so an immediate warm re-mount with identical
      // props re-guards without re-loading (the multi-tab storm).
      lastProps: canonicalProps(search),
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
   * Sum a session's held state bytes ({@link LiveInstance.stateBytes}, ADR 0002
   * item 14). Computed on demand over the session's ≤ `maxInstancesPerSession`
   * (32) entries — trivially cheap and drift-free (no per-flush bookkeeping to
   * fall out of sync across eviction/re-mount churn) — and only ever called
   * behind the `maxSessionStateBytes != null` guard, so a disabled budget never
   * serializes any state.
   */
  function sessionStateBytes(m: Map<string, InstanceEntry>): number {
    let total = 0;
    for (const entry of m.values()) total += entry.instance.stateBytes;
    return total;
  }

  /**
   * Reclaim a session's byte budget by shedding its idle (unsubscribed)
   * instances, oldest first, until the running sum drops under `budget` or no
   * idle instance remains (ADR 0002 item 14). Mirrors {@link shedIdleInstances}'
   * cap-side shedding: a subscribed instance is **never** dropped for budget —
   * an idle instance's bytes are reclaimable without severing a live connection.
   */
  function shedIdleForBudget(m: Map<string, InstanceEntry>, budget: number): void {
    for (const entry of [...m.values()]) {
      if (sessionStateBytes(m) < budget) break;
      if (entry.instance.subscriberCount > 0) continue; // never evict a subscribed instance
      emitSecurity("cap-evicted", { reason: "budget", sid: entry.sid, path: entry.key });
      evictEntry(entry);
    }
  }

  /**
   * Charge the per-session mount throttle `cost` tokens (ADR 0002 item 14): a
   * single `mount` costs 1, a `mount-batch` costs one per entry so a batch can't
   * bypass the limit. Returns `true` (proceed) when the throttle is disabled or a
   * token was available, `false` (refuse) when the bucket is drained — consuming
   * nothing on refusal, so an over-budget batch is rejected wholesale. The bucket
   * map is bounded like {@link throttleBuckets} so a sid-rotating flood can't leak
   * memory (a reset bucket starts full — lenient, never a bypass of an active limit).
   */
  function takeMountTokens(sid: string, cost: number): boolean {
    if (mountRateLimit == null) return true;
    let bucket = mountThrottleBuckets.get(sid);
    if (!bucket) {
      if (mountThrottleBuckets.size >= MAX_THROTTLE_KEYS) {
        const oldest = mountThrottleBuckets.keys().next().value;
        if (oldest !== undefined) mountThrottleBuckets.delete(oldest);
      }
      bucket = new TokenBucket(mountRateLimit);
      mountThrottleBuckets.set(sid, bucket);
    }
    return bucket.takeN(cost);
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

    const stream = new ReadableStream<Uint8Array>(
      {
        start(controller) {
          const encoder = new TextEncoder();
          let handle: StreamHandle | undefined;
          let overflowed = false;
          // Egress budget kill (§11 slow-consumer guard): error the stream —
          // discarding its buffered queue, the memory being protected — and
          // detach its listeners so eviction re-arms. The client's reconnect
          // recovers via the full-snapshot resync on re-subscribe.
          const kill = () => {
            overflowed = true;
            emitSecurity("stream-overflow", { sid, transport: "sse" });
            if (handle) {
              unregisterStream(sid, streamId);
              handle.cleanup();
            }
            try {
              controller.error(new Error("egress buffer exceeded maxBufferedBytes"));
            } catch {
              // already closed/errored
            }
          };
          controller.enqueue(encoder.encode("retry: 1000\n\n"));
          const h = subscribeSession(
            sid,
            (env) => {
              if (overflowed) return;
              try {
                controller.enqueue(encoder.encode(encodeSse(env)));
              } catch {
                return; // stream already closed; eviction handles cleanup
              }
              // With the byte-length strategy below, desiredSize < 0 ⇔ unread
              // bytes exceed the budget — the reader isn't keeping up.
              if (maxBufferedBytes != null && (controller.desiredSize ?? 0) < 0) kill();
            },
            { token: attachToken, seq: attachSeq },
          );
          handle = h;
          if (overflowed) {
            // The kill fired during the initial snapshot fan-out, before the
            // handle existed — finish its cleanup now, and never register.
            h.cleanup();
            return;
          }
          registerStream(sid, streamId, h);
          req.signal.addEventListener("abort", () => {
            unregisterStream(sid, streamId);
            h.cleanup();
            try {
              controller.close();
            } catch {
              // already closed
            }
          });
        },
      },
      // The budget is bytes, so measure the queue in bytes: desiredSize turns
      // negative once unread chunks outweigh the budget. No strategy (chunk
      // counting) when the budget is off.
      maxBufferedBytes != null
        ? new ByteLengthQueuingStrategy({ highWaterMark: maxBufferedBytes })
        : undefined,
    );

    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      },
    });
  }

  /**
   * The outcome of mounting ONE control-plane entry (ADR 0002 items 6 + 11):
   * `ok` (mounted + joined), `redirect` (a `setup`/`guard` deny), or `error`
   * (a client-fault the caller maps to a status / positional `{ error }`). The
   * single `mount` and every `mount-batch` entry both go through {@link mountOne},
   * so the two share one lifecycle (stop-signal #1 — parameterize, don't fork).
   */
  type MountOutcome =
    | { kind: "ok"; entry: InstanceEntry }
    | { kind: "redirect"; location: string }
    | {
        kind: "error";
        error: ValidationError | NotFoundError | SessionCapError | SessionBudgetError;
      };

  /**
   * Mount one control-plane entry through the EXACT single-mount path (ADR 0002
   * item 11): validate props against the matched registration's schema (before
   * `guard`, so untrusted input never reaches it), build the instance, and — when
   * a `stream` is named — join it to that open transport. Client-fault throws
   * (props-invalid / not-found / cap) are captured as `{ kind: "error" }` and a
   * deny as `{ kind: "redirect" }`, so a single caller can re-throw for its
   * status while a batch caller records a positional result — **one entry's
   * failure never poisons its siblings**. Only a genuinely unexpected throw
   * escapes (a real 5xx / per-entry catch).
   */
  async function mountOne(
    path: string,
    rawProps: Record<string, unknown> | undefined,
    sid: string,
    sessionData: unknown,
    stream: string | undefined,
    registrations: RouteRegistration[],
  ): Promise<MountOutcome> {
    let entry: InstanceEntry;
    try {
      const props = await resolveMountProps(path, rawProps ?? {}, registrations);
      entry = await mountInstance(sid, sessionData, path, props, registrations);
    } catch (e) {
      if (isRedirect(e)) return { kind: "redirect", location: e.location };
      if (
        e instanceof ValidationError ||
        e instanceof NotFoundError ||
        e instanceof SessionCapError ||
        e instanceof SessionBudgetError
      ) {
        return { kind: "error", error: e };
      }
      throw e; // genuinely unexpected — propagate (single: 5xx; batch: per-entry catch)
    }
    // Tier-2 soft reload / batch join (§7): a `stream` id joins the fresh
    // instance to that already-open transport so its snapshot flows at once.
    if (stream) streamRegistry.get(sid)?.get(stream)?.subscribeInstance(entry);
    return { kind: "ok", entry };
  }

  // WIRE CONTRACT — the control-plane messages (mount/mount-batch/resync/url/
  // release) and the `?attach&seq` adoption below are documented in
  // docs-site/src/content/docs/concepts/wire-protocol.md and pinned by
  // packages/core/test/protocol-conformance.test.ts. Change all three together.
  async function handleControl(req: Request, sid: string, sessionData: unknown) {
    const msg = (await readJsonCapped(req, maxBodyBytes)) as
      | { type: "mount"; path: string; props?: Record<string, unknown>; stream?: string }
      | {
          type: "mount-batch";
          mounts?: { path?: string; props?: Record<string, unknown> }[];
          stream?: string;
        }
      | { type: "resync"; instance: string }
      | { type: "release"; instance: string; stream: string }
      | { type: "url"; instance: string; props: Record<string, unknown> };

    if (msg.type === "mount") {
      // Per-session mount throttle (ADR 0002 item 14): a single mount costs one
      // token. Drained → 429 → the client's slot falls back; existing instances
      // are untouched (only new mounts are gated).
      if (!takeMountTokens(sid, 1)) {
        emitSecurity("mount-throttled", { sid, path: msg.path });
        return new Response("mount rate limited", { status: 429 });
      }
      // The control plane mounts over the union (routes ∪ slots, ADR 0002 item 6).
      const outcome = await mountOne(
        msg.path,
        msg.props,
        sid,
        sessionData,
        msg.stream,
        mountable(),
      );
      // `setup`/`guard` denied (§10): tell the client to navigate rather than
      // instantiate. A GET load handles this as a 302 (see fetch catch).
      if (outcome.kind === "redirect") return Response.json({ redirect: outcome.location });
      // ValidationError / NotFoundError / SessionCapError / SessionBudgetError →
      // `mapRequestError` (422 / 404 / 429 / 429) — nothing was built. Re-throw
      // to preserve the status.
      if (outcome.kind === "error") throw outcome.error;
      const entry = outcome.entry;
      return Response.json({
        instance: entry.instance.id,
        seq: entry.instance.seq,
        path: entry.path,
        params: entry.params,
      });
    }

    if (msg.type === "mount-batch") {
      // Batched slot mounts (ADR 0002 item 11): N same-tick `mountSlot` calls
      // coalesced into ONE POST. Validate the frame shape (untrusted wire data),
      // bound the length, then run the EXACT single-mount path per entry and
      // answer POSITIONALLY — `results[i]` for `mounts[i]`, one entry's failure
      // never poisoning its siblings.
      const mounts = msg.mounts;
      if (!Array.isArray(mounts)) {
        return new Response("malformed mount-batch: `mounts` must be an array", { status: 400 });
      }
      // Sanity cap on top of the natural maxBodyBytes bound: an over-cap batch is
      // rejected wholesale (413), nothing mounted — like an over-size body.
      if (mounts.length > MAX_MOUNT_BATCH) {
        return new Response(`mount-batch exceeds MAX_MOUNT_BATCH (${MAX_MOUNT_BATCH})`, {
          status: 413,
        });
      }
      // Per-session mount throttle (ADR 0002 item 14): a batch costs one token
      // PER ENTRY, so it can't bypass the limit a single mount pays. Charged
      // atomically — an over-budget batch is refused wholesale (429, nothing
      // mounted), consuming no tokens (like the MAX_MOUNT_BATCH 413 above).
      // Checked after the length cap so an over-cap batch still 413s.
      if (!takeMountTokens(sid, mounts.length)) {
        emitSecurity("mount-throttled", { sid, count: mounts.length });
        return new Response("mount rate limited", { status: 429 });
      }
      // Fan-out doctrine diagnostic (Decision 6): a dev-only nudge toward
      // "Aggregates, not rows" when a page mounts too many sibling slots at once
      // (a list of slots = a missing aggregate). Gated on isDev() — NEVER in
      // production (a real deployment's slot count is not an operator's concern).
      if (isDev() && mounts.length > SLOT_FANOUT_ADVICE) {
        emit({
          category: "instance",
          type: "slot-fanout-high",
          level: "warn",
          detail: { count: mounts.length },
        });
      }
      const registrations = mountable();
      const results = await Promise.all(
        mounts.map(async (m): Promise<MountBatchResult> => {
          // Per-entry shape guard (untrusted): a malformed entry is its own
          // `{ error }` result, never a throw that poisons the whole batch.
          if (!m || typeof m.path !== "string") {
            return { error: { name: "ProtocolError", message: "invalid mount entry" } };
          }
          try {
            const outcome = await mountOne(
              m.path,
              m.props,
              sid,
              sessionData,
              msg.stream,
              registrations,
            );
            if (outcome.kind === "redirect") return { redirect: outcome.location };
            if (outcome.kind === "error") {
              return { error: { name: outcome.error.name, message: outcome.error.message } };
            }
            return {
              instance: outcome.entry.instance.id,
              seq: outcome.entry.instance.seq,
              path: outcome.entry.path,
              params: outcome.entry.params,
            };
          } catch (e) {
            // A genuinely unexpected per-entry throw: report it, but keep the
            // batch total — this one entry answers `{ error }`, siblings resolve.
            emit({
              category: "request",
              type: "mount-batch-entry-failed",
              level: "error",
              error: e,
            });
            return {
              error: { name: "InternalError", message: safeErrorMessage(e, "mount failed") },
            };
          }
        }),
      );
      return Response.json({ results });
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
    // Runtime URL change (nav.patch, §7): validate the props patch against the
    // instance's registration schema (ADR 0002 item 7), then reconcile guard+load.
    // An invalid record throws ValidationError → 422 via `mapRequestError` (the
    // item-3 `props-invalid` surface), before any guard/load. A guard deny →
    // redirect JSON for the client to soft-nav (§10). Look across the mount union
    // so a slot instance finds its own def (ADR 0002 item 6).
    const route = registrationFor(entry.path);
    try {
      if (route) {
        const props = await resolveUrlProps(route, msg.props);
        await reconcileEntry(entry, route.def, props); // item 8 dedup: re-guard always, re-load on change
      }
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
      // GET serves routed pages ONLY (ADR 0002 item 6): a mount-only slot
      // pattern is not page-addressable. Reject it here — over `opts.routes`,
      // not the mount union — BEFORE `mountInstance`, so a slot already warmed
      // via the control plane (keyed by this pathname) can't be adopted by
      // warm-reuse and served as a page. A real route falls through unchanged.
      if (
        !matchRoute(
          opts.routes.map((r) => r.path),
          url.pathname,
        )
      ) {
        throw new NotFoundError(url.pathname);
      }
      // SSR (§12): setup+guard+load run during SSR; the connection adopts the warm
      // instance via the attach token. Props codec (ADR 0002 §3): a schema'd
      // route decodes + validates the query into typed props here, before the
      // mount, so guard/load never see unvalidated input (a violation → 422).
      const search = await resolveGetProps(url.pathname, url.searchParams);
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
    // Invalid props on a page GET (ADR 0002 §3): the decoded `?query` failed the
    // route's props schema. It's a well-formed request carrying unprocessable
    // input — a 4xx client error, not a crash — so answer 422 (nothing was
    // built; validation ran before guard/load). A `request`/`props-invalid`
    // diagnostic records it; the body stays generic so the schema's issue
    // messages never leak (#9), matching the auth-deny surface.
    if (err instanceof ValidationError) {
      emit({
        category: "request",
        type: "props-invalid",
        level: "warn",
        detail: { path: url.pathname },
      });
      return withSession(new Response("invalid props", { status: 422 }), sid, isNew);
    }
    // The session is at its instance cap with every slot subscribed (C) —
    // shed load like the throttle does, on both the control and GET paths.
    if (err instanceof SessionCapError) {
      return withSession(new Response(err.message, { status: 429 }), sid, isNew);
    }
    // The session is over its soft state byte budget and shedding idle instances
    // couldn't free enough (ADR 0002 item 14) — refuse the new mount with 429,
    // matching the cap surface. Existing instances were never touched.
    if (err instanceof SessionBudgetError) {
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
      mountThrottleBuckets.clear();
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
                /** `mount` props (ADR 0002 item 6) — a JSON value model; `url` props are raw strings. */
                props?: Record<string, unknown>;
                /** Client correlation id for `mount` (#65) — echoed on the outcome envelope. */
                mountId?: string;
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
            // Per-session mount throttle (ADR 0002 item 14): parity with HTTP
            // control. Over WS there's no response slot, so answer a drained
            // bucket with an unbound (`instance: ""`) error envelope the client
            // correlates by `mountId` (#65) — mirroring the cap/not-found surface
            // below. Existing instances are untouched.
            if (!takeMountTokens(sid, 1)) {
              emitSecurity("mount-throttled", { sid, path: msg.path });
              send({
                seq: 0,
                instance: "",
                error: { name: "MountThrottleError", message: "mount rate limited" },
                ...(msg.mountId !== undefined && { mountId: msg.mountId }),
              });
              return;
            }
            // The socket *is* the stream (§11): join the mount to it directly.
            // `subscribeInstance` is idempotent, so a warm re-mount is a no-op.
            // Mounts over WS match the same union as HTTP control (ADR 0002 item 6).
            const registrations = mountable();
            try {
              // Validate props against the matched registration's schema before
              // the mount (untrusted) — a violation throws ValidationError,
              // answered on the socket by the catch below (the WS surface).
              const props = await resolveMountProps(msg.path, msg.props ?? {}, registrations);
              const entry = await mountInstance(sid, sessionData, msg.path, props, registrations);
              subscribeInstance(entry);
            } catch (e) {
              // Answer denials on the socket (mirroring the `url` branch) —
              // thrown out, they'd otherwise die in the transport's generic
              // catch and the client waits forever.
              const warm = sessions.get(sid)?.get(msg.path);
              // A failed mount usually has no bound instance to address the
              // outcome to, so echo the frame's correlation id (#65) — the
              // client matches it against its in-flight mount.
              const mountId = msg.mountId;
              if (isRedirect(e)) {
                send({
                  seq: warm?.instance.seq ?? 0,
                  instance: warm?.instance.id ?? "",
                  redirect: e.location,
                  ...(mountId !== undefined && { mountId }),
                });
              } else if (
                e instanceof SessionCapError ||
                e instanceof SessionBudgetError ||
                e instanceof NotFoundError ||
                e instanceof ValidationError
              ) {
                // WS mount parity for the mount-time rejections that HTTP control
                // answers as a status (429 / 429 / 404 / 422). Over WS there is no
                // response slot, so answer the socket with an unbound
                // (`instance: ""`) error envelope the client correlates by
                // `mountId` (#65) — invalid props included (ADR 0002 item 6).
                send({
                  seq: 0,
                  instance: "",
                  error: { name: e.name, message: e.message },
                  ...(mountId !== undefined && { mountId }),
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
          if (msg.type === "url" && msg.props) {
            // Runtime URL change over WS (§7): validate the props patch against
            // the instance's registration schema (ADR 0002 item 7), then reconcile
            // guard+load. A guard deny → a redirect envelope for the client to
            // soft-nav (§10). Look across the mount union so a slot instance finds
            // its own def (item 6).
            const route = registrationFor(entry.path);
            try {
              if (route) {
                const props = await resolveUrlProps(route, msg.props);
                await reconcileEntry(entry, route.def, props); // item 8 dedup: re-guard always, re-load on change
              }
            } catch (e) {
              if (isRedirect(e)) {
                send({
                  seq: entry.instance.seq,
                  instance: entry.instance.id,
                  redirect: e.location,
                });
              } else if (e instanceof ValidationError) {
                // WS parity for the 422 the HTTP control path returns on an
                // invalid props patch. Unlike a denied `mount` — which has no
                // bound instance and correlates by `mountId` (#65) — a `url`
                // patch names an already-bound instance, so answer with an
                // instance-scoped error envelope (mirroring the redirect surface
                // just above): the client filters it by the bound instance id,
                // no correlation id needed. No reconcile ran (guard/load never saw
                // the invalid record).
                send({
                  seq: entry.instance.seq,
                  instance: entry.instance.id,
                  error: { name: e.name, message: e.message },
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

    /** The resolved egress byte budget (§11, `null` = disabled) — shared with
     * the WS transport so both transports enforce one budget. */
    maxBufferedBytes,

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

/**
 * A fresh mount would leave the session over its soft `maxSessionStateBytes`
 * budget and no idle instance could be shed to make room (ADR 0002 item 14) —
 * mapped to `429` on HTTP, an error envelope on WS. Existing instances' flushes
 * and rpcs are never rejected; only the new mount is refused.
 */
class SessionBudgetError extends Error {
  constructor() {
    super("session state byte budget exceeded");
    this.name = "SessionBudgetError";
  }
}

let unsignedSidWarned = false;
/**
 * Warn once per process that cookie signing was explicitly disabled (S1). Only
 * fires for the deliberate `cookie: { sign: false }` escape hatch — signing is
 * on by default, so this no longer fires for an unconfigured secret (that case
 * now signs, via an ephemeral dev secret or a required prod one).
 */
function warnUnsignedSid(): void {
  if (unsignedSidWarned) return;
  unsignedSidWarned = true;
  console.warn(
    "[rpxd] cookie signing explicitly disabled (cookie.sign:false) — the sid is forgeable.",
  );
}

let ephemeralDevSecretWarned = false;
/**
 * Warn once per process that dev is running on an ephemeral, process-lifetime
 * session secret (S1) — config-time, so `console.*` is the intentional
 * exception (CLAUDE.md "Conventions").
 */
function warnEphemeralDevSecret(): void {
  if (ephemeralDevSecretWarned) return;
  ephemeralDevSecretWarned = true;
  console.info(
    "[rpxd] using an ephemeral dev session secret — set RPXD_SESSION_SECRET for sessions stable across restarts.",
  );
}
