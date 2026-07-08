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

/** One registered HTTP route (`route()`, docs/routes-and-auth.md): path + method handlers. */
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
  /** Server-only HTTP routes (`route()`, docs/routes-and-auth.md), matched before SSR. */
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
  /** Mount-rejection / crash page (§10, §14 `__error`). Defaults to plain text. */
  renderError?: (info: { path: string; error: unknown }) => Response | Promise<Response>;
  /** Warm TTL before an unsubscribed instance is snapshotted + evicted (§11). Default 60s. */
  warmTtlMs?: number;
  /** Pending-attach TTL for SSR adoption tokens (§12). Default 10s. */
  attachTtlMs?: number;
  defaultRateLimit?: RateLimit;
}

interface InstanceEntry {
  // biome-ignore lint/suspicious/noExplicitAny: registry spans routes of any state shape
  instance: LiveInstance<any, any, any>;
  path: string;
  params: Record<string, string>;
  attach?: { token: string; expires: number };
  evictTimer?: ReturnType<typeof setTimeout>;
}

const SID_COOKIE = "rpxd_sid";

/**
 * Encode one envelope as an SSE event (`docs/protocol.md` framing).
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
 * - `POST /__rpxd/control` — `mount` / `resync` / `params`
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
  /** sessionId → instanceKey → entry */
  const sessions = new Map<string, Map<string, InstanceEntry>>();
  const byInstanceId = new Map<string, InstanceEntry>();
  let disposed = false;

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
        return existing;
      }
      // The authenticated session changed (login/logout, §10): the principal —
      // and any session-scoped state `mount` computed — is stale. Evict, drop
      // the snapshot, and re-mount fresh below rather than adopt the warm
      // instance (§12), which would render the old principal.
      if (existing.evictTimer) clearTimeout(existing.evictTimer);
      entries.delete(pathname);
      byInstanceId.delete(existing.instance.id);
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
    // Fire the params loader after mount (§7) — the single place URL-dependent
    // data loads, on first paint and on every later nav.patch. SSR sequencing
    // (§12): a route opting into `blockSsr` awaits the full load so the first
    // document carries data (crawlable). The default streams: the loader runs
    // synchronously up to its first `await`, so once `setSearch` returns its
    // projection (filter/loading chrome) is already staged — we flush exactly
    // that and serialize it, then let the awaited data stream in over SSE.
    if (route.def.params) {
      const run = instance.setSearch(search).catch(() => {});
      if (route.def.paramsOptions?.blockSsr) await run;
      else await instance.flushStaged();
    }

    const entry: InstanceEntry = {
      instance,
      path: match.path,
      params: match.params,
      attach: { token: crypto.randomUUID(), expires: Date.now() + attachTtlMs },
    };
    entries.set(pathname, entry);
    byInstanceId.set(instance.id, entry);
    scheduleEvictionIfIdle(sid, pathname, entry);
    return entry;
  }

  function scheduleEvictionIfIdle(sid: string, key: string, entry: InstanceEntry): void {
    if (entry.instance.subscriberCount > 0 || entry.evictTimer || disposed) return;
    // Keep pending-attach instances alive at least until the token expires.
    const graceMs = Math.max(warmTtlMs, (entry.attach?.expires ?? 0) - Date.now());
    entry.evictTimer = setTimeout(() => {
      if (entry.instance.subscriberCount > 0) return;
      sessions.get(sid)?.delete(key);
      byInstanceId.delete(entry.instance.id);
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
  ): { subscribeInstance: (entry: InstanceEntry) => void; cleanup: () => void } {
    const entries = entriesFor(sid);
    const unsubs: (() => void)[] = [];

    const subscribeInstance = (entry: InstanceEntry, initial = false) => {
      if (entry.evictTimer) {
        clearTimeout(entry.evictTimer);
        entry.evictTimer = undefined;
      }
      unsubs.push(entry.instance.addListener(send));
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

    for (const entry of entries.values()) subscribeInstance(entry, true);

    return {
      subscribeInstance: (entry) => subscribeInstance(entry, false),
      cleanup: () => {
        for (const unsub of unsubs) unsub();
        for (const [key, entry] of entries) scheduleEvictionIfIdle(sid, key, entry);
      },
    };
  }

  async function handleStream(req: Request, sid: string): Promise<Response> {
    const url = new URL(req.url);
    const attachToken = url.searchParams.get("attach");
    const attachSeq = Number(url.searchParams.get("seq") ?? "-1");

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        controller.enqueue(encoder.encode("retry: 1000\n\n"));
        const { cleanup } = subscribeSession(
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
        req.signal.addEventListener("abort", () => {
          cleanup();
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
      | { type: "mount"; path: string; search?: Record<string, string> }
      | { type: "resync"; instance: string }
      | { type: "params"; instance: string; search: Record<string, string> };

    if (msg.type === "mount") {
      let entry: InstanceEntry;
      try {
        entry = await mountInstance(sid, sessionData, msg.path, msg.search ?? {});
      } catch (e) {
        // `mount` threw redirect() (§10): tell the client to navigate rather
        // than mount. A GET load handles this as a 302 (see fetch catch).
        if (isRedirect(e)) return Response.json({ redirect: e.location });
        throw e;
      }
      return Response.json({
        instance: entry.instance.id,
        seq: entry.instance.seq,
        path: entry.path,
        params: entry.params,
      });
    }
    const entry = byInstanceId.get(msg.instance);
    if (!entry) return new Response("unknown instance", { status: 404 });
    if (msg.type === "resync") {
      entry.instance.resync();
      return new Response(null, { status: 204 });
    }
    await entry.instance.setSearch(msg.search);
    return new Response(null, { status: 204 });
  }

  async function handleRpc(req: Request): Promise<Response> {
    const batch = (await req.json()) as RpcBatch;
    const entry = byInstanceId.get(batch.instance);
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
          return withSession(await handleRpc(req), sid, isNew);
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
          // SSR (§12): mount runs during SSR; the connection adopts the warm
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
        // `mount` threw redirect() (§10): a full page load follows a real 302.
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
        // mount rejection → error route (§10)
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
      const { subscribeInstance, cleanup } = subscribeSession(sid, send, attach);
      return {
        async message(raw: string): Promise<void> {
          const msg = JSON.parse(raw) as
            | RpcBatch
            | {
                type: "resync" | "params" | "mount";
                instance?: string;
                path?: string;
                search?: Record<string, string>;
              };
          if ("calls" in msg) {
            const entry = byInstanceId.get(msg.instance);
            if (entry) void entry.instance.handleBatch(msg);
            return;
          }
          if (msg.type === "mount" && msg.path) {
            const known = entriesFor(sid).get(msg.path);
            const entry = await mountInstance(sid, sessionData, msg.path, msg.search ?? {});
            if (!known) subscribeInstance(entry); // late mounts join this socket
            return;
          }
          const entry = msg.instance ? byInstanceId.get(msg.instance) : undefined;
          if (!entry) return;
          if (msg.type === "resync") entry.instance.resync();
          if (msg.type === "params" && msg.search) await entry.instance.setSearch(msg.search);
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
