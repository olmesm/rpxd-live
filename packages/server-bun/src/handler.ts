/**
 * The rpxd HTTP runtime (§11, §12): session cookies, instance registry,
 * SSE patch stream, rpc/control endpoints, SSR mount + attach adoption,
 * warm-TTL eviction. Web-standard `Request`/`Response` only — served
 * through any {@link ServerAdapter}.
 */
import {
  type Envelope,
  isRedirect,
  type LiveDefinition,
  LiveInstance,
  memory,
  type RateLimit,
  type RouteDefinition,
  type RouteMethod,
  type RpcBatch,
  type StorageAdapter,
} from "@rpxd/core";
import { matchHttpRoute, matchRoute } from "./match.ts";

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
  /** SSR renderer (§12). Defaults to a minimal HTML shell embedding the bootstrap payload. */
  render?: (ctx: RenderContext) => Response | Promise<Response>;
  /** Unmatched-URL page (§14 `__404`). Defaults to a plain-text 404. */
  renderNotFound?: (info: { path: string }) => Response | Promise<Response>;
  /** setup/guard/load-rejection / crash page (§10, §14 `__error`). Defaults to plain text. */
  renderError?: (info: { path: string; error: unknown }) => Response | Promise<Response>;
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
  defaultRateLimit?: RateLimit;
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
  cleanup: () => void;
}

const SID_COOKIE = "rpxd_sid";

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
  const warmTtlMs = opts.warmTtlMs ?? 60_000;
  const attachTtlMs = opts.attachTtlMs ?? 10_000;
  // Un-attached instances only need to outlive their attach window (#61).
  const unattachedTtlMs = opts.unattachedTtlMs ?? attachTtlMs;
  const maxUnattachedInstances =
    opts.maxUnattachedInstances === undefined ? 1024 : opts.maxUnattachedInstances;
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
  /** sessionId → client stream id → live SSE subscriber (§7 tier-2 late mount). */
  const streamRegistry = new Map<string, Map<string, StreamHandle>>();
  let disposed = false;

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
    const cookie = req.headers.get("cookie") ?? "";
    const found = cookie
      .split(";")
      .map((c) => c.trim())
      .find((c) => c.startsWith(`${SID_COOKIE}=`));
    if (found) return { sid: found.slice(SID_COOKIE.length + 1), isNew: false };
    return { sid: crypto.randomUUID(), isNew: true };
  }

  function withSession(res: Response, sid: string, isNew: boolean): Response {
    if (isNew) {
      res.headers.append("set-cookie", `${SID_COOKIE}=${sid}; Path=/; HttpOnly; SameSite=Lax`);
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
  // the redirect propagates to the caller. SSR sequencing (§12): `blockSsr`
  // awaits the full load so the first document carries data (crawlable); the
  // default streams — the loader runs synchronously up to its first `await`, so
  // once it hands back its projection is staged; we flush exactly that and
  // serialize it, then let the awaited data stream in over the push stream.
  async function reconcileUrl(
    def: RouteRegistration["def"],
    instance: InstanceEntry["instance"],
    search: Record<string, string | undefined>,
  ): Promise<void> {
    if (def.guard) await instance.authorize(search); // deny → throw redirect → 302
    if (!def.load) return;
    const run = instance.load(search);
    if (def.loadOptions?.blockSsr)
      await run; // loader redirect → propagates → 302
    else {
      void run.catch(() => {}); // stream: a loader redirect is swallowed — use guard
      await instance.flushStaged();
    }
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

    const match = matchRoute(
      opts.routes.map((r) => r.path),
      pathname,
    );
    if (!match) throw new NotFoundError(pathname);
    const route = opts.routes.find((r) => r.path === match.path) as RouteRegistration;

    const instance = await LiveInstance.create({
      id: crypto.randomUUID(),
      def: route.def,
      params: match.params,
      session: (sessionData as Record<string, unknown>) ?? {},
      storage,
      storageKey: `${sid}:${pathname}`,
      defaultRateLimit: opts.defaultRateLimit,
    });
    await reconcileUrl(route.def, instance, search);

    const entry: InstanceEntry = {
      instance,
      sid,
      key: pathname,
      path: match.path,
      params: match.params,
      attach: { token: crypto.randomUUID(), expires: Date.now() + attachTtlMs },
      everAttached: false,
    };
    entries.set(pathname, entry);
    byInstanceId.set(instance.id, entry);
    unattached.add(entry);
    enforceUnattachedCap(entry);
    scheduleEvictionIfIdle(sid, pathname, entry);
    return entry;
  }

  /**
   * Shed least-recently-used never-attached instances until the set is within
   * {@link RpxdHandlerOptions.maxUnattachedInstances} (#61). `keep` is the entry
   * we just registered — never evict it, even if the cap is 0/1. Cap-evictions
   * dispose *without* a snapshot and delete any storage a cookieless mount left
   * behind: it was never an adopted session, so persisting it is pure waste.
   */
  function enforceUnattachedCap(keep: InstanceEntry): void {
    if (maxUnattachedInstances == null) return;
    for (const entry of unattached) {
      if (unattached.size <= maxUnattachedInstances) break;
      if (entry === keep) continue;
      if (entry.evictTimer) {
        clearTimeout(entry.evictTimer);
        entry.evictTimer = undefined;
      }
      unattached.delete(entry);
      sessions.get(entry.sid)?.delete(entry.key);
      byInstanceId.delete(entry.instance.id);
      void entry.instance
        .dispose(false)
        .then(() => storage.delete(`${entry.sid}:${entry.key}`))
        .catch(() => {});
    }
  }

  /**
   * Mark an instance attached (#61) — a client has subscribed. It leaves the
   * un-attached LRU set (exempt from the cap) and earns the full warm TTL.
   */
  function markAttached(entry: InstanceEntry): void {
    entry.everAttached = true;
    unattached.delete(entry);
  }

  function scheduleEvictionIfIdle(sid: string, key: string, entry: InstanceEntry): void {
    if (entry.instance.subscriberCount > 0 || entry.evictTimer || disposed) return;
    // A never-attached instance only needs to outlive its attach window (#61);
    // once adopted, it earns the full warm TTL. Either way, keep a
    // pending-attach instance alive at least until its token expires.
    const baseTtl = entry.everAttached ? warmTtlMs : unattachedTtlMs;
    const graceMs = Math.max(baseTtl, (entry.attach?.expires ?? 0) - Date.now());
    entry.evictTimer = setTimeout(() => {
      if (entry.instance.subscriberCount > 0) return;
      sessions.get(sid)?.delete(key);
      byInstanceId.delete(entry.instance.id);
      unattached.delete(entry);
      void entry.instance.dispose(); // final write-through snapshot (§11)
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
        entry.attach.token === attach.token &&
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
      if (entry) scheduleEvictionIfIdle(sid, entry.key, entry);
    };

    for (const entry of entries.values()) subscribeInstance(entry, true);

    return {
      subscribeInstance: (entry) => subscribeInstance(entry, false),
      releaseInstance,
      cleanup: () => {
        for (const unsub of unsubs.values()) unsub();
        for (const [key, entry] of entries) scheduleEvictionIfIdle(sid, key, entry);
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

  async function handleControl(req: Request, sid: string, sessionData: unknown) {
    const msg = (await req.json()) as
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
    const batch = (await req.json()) as RpcBatch;
    const entry = ownedInstance(batch.instance, sid);
    if (!entry) return new Response("unknown instance", { status: 404 });
    // Fire-and-forget: the ack rides the SSE stream, not this response.
    void entry.instance.handleBatch(batch);
    return new Response(null, { status: 202 });
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

  return {
    async fetch(req: Request): Promise<Response> {
      const url = new URL(req.url);
      const { sid, isNew } = sessionOf(req);

      let sessionData: unknown = {};
      if (opts.authenticate) {
        try {
          sessionData = await opts.authenticate(req, { sid });
        } catch (e) {
          return new Response(e instanceof Error ? e.message : "forbidden", { status: 403 });
        }
      }

      try {
        if (url.pathname === "/__rpxd/stream") {
          return withSession(await handleStream(req, sid), sid, isNew);
        }
        if (url.pathname === "/__rpxd/rpc" && req.method === "POST") {
          return withSession(await handleRpc(req, sid), sid, isNew);
        }
        if (url.pathname === "/__rpxd/control" && req.method === "POST") {
          return withSession(await handleControl(req, sid, sessionData), sid, isNew);
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
            const fn = reg.def.handlers[method] ?? reg.def.handlers.ALL;
            if (!fn) {
              return withSession(new Response("method not allowed", { status: 405 }), sid, isNew);
            }
            const res = await fn(req, { params: hit.params, session: sessionData, sid });
            return withSession(res, sid, isNew);
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
          const ctx: RenderContext = {
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
          return withSession(await render(ctx), sid, isNew);
        }
        return new Response("not found", { status: 404 });
      } catch (e) {
        // `setup`/`guard`/`load` threw redirect() (§10): a full page load follows a real 302.
        if (isRedirect(e)) {
          return withSession(
            new Response(null, { status: e.status, headers: { location: e.location } }),
            sid,
            isNew,
          );
        }
        if (e instanceof NotFoundError) {
          if (opts.renderNotFound) {
            return withSession(await opts.renderNotFound({ path: url.pathname }), sid, isNew);
          }
          return new Response("not found", { status: 404 });
        }
        // setup/load rejection → error route (§10)
        if (opts.renderError) {
          return withSession(await opts.renderError({ path: url.pathname, error: e }), sid, isNew);
        }
        return new Response(e instanceof Error ? e.message : "internal error", { status: 500 });
      }
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
          const msg = JSON.parse(raw) as
            | RpcBatch
            | {
                type: "resync" | "url" | "mount" | "release";
                instance?: string;
                path?: string;
                search?: Record<string, string>;
              };
          if ("calls" in msg) {
            const entry = ownedInstance(msg.instance, sid);
            if (entry) void entry.instance.handleBatch(msg);
            return;
          }
          if (msg.type === "mount" && msg.path) {
            // The socket *is* the stream (§11): join the mount to it directly.
            // `subscribeInstance` is idempotent, so a warm re-mount is a no-op.
            const entry = await mountInstance(sid, sessionData, msg.path, msg.search ?? {});
            subscribeInstance(entry);
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

    /** Test/introspection hook: number of live instances across sessions. */
    get instanceCount(): number {
      return byInstanceId.size;
    },
  };
}

class NotFoundError extends Error {
  constructor(pathname: string) {
    super(`No route matches ${pathname}`);
  }
}
