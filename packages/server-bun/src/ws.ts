/**
 * WS transport glue (§11 `transport: ws()`): one duplex socket carrying the
 * same envelopes/batches as SSE+POST — the protocol is transport-agnostic,
 * only framing differs (the wire protocol guide).
 */
import type { SocketLike, WebSocketHandlers } from "./adapter.ts";
import type { createRpxdHandler } from "./handler.ts";

type RpxdHandler = ReturnType<typeof createRpxdHandler>;
type SocketSession = ReturnType<RpxdHandler["socket"]>;

interface WsData {
  sid: string;
  sessionData: unknown;
  attach: { token: string | null; seq: number };
  session: SocketSession | null;
}

/**
 * Build the websocket handlers + upgrade hook for a serve adapter.
 *
 * @example
 * ```ts
 * const ws = wsTransport(handler, { authenticate });
 * bunAdapter().serve({
 *   websocket: ws.websocket,
 *   fetch: async (req, upgrade) =>
 *     (await ws.handleUpgrade(req, upgrade)) ?? handler.fetch(req),
 * });
 * ```
 */
export function wsTransport(
  handler: RpxdHandler,
  opts: { authenticate?: (req: Request, ctx: { sid: string }) => unknown | Promise<unknown> } = {},
) {
  const websocket: WebSocketHandlers = {
    open(socket: SocketLike) {
      const data = socket.data as WsData;
      data.session = handler.socket(
        data.sid,
        data.sessionData,
        (env) => socket.send(JSON.stringify(env)),
        data.attach,
      );
    },
    message(socket: SocketLike, message: string) {
      void (socket.data as WsData).session?.message(message).catch((e) => {
        console.error("[rpxd] ws message failed:", e);
      });
    },
    close(socket: SocketLike) {
      (socket.data as WsData).session?.close();
    },
  };

  /**
   * Authenticate the upgrade request and build the per-socket data the
   * `websocket` handlers expect. Returns a `Response` (403) when
   * authentication rejects. Adapter-agnostic — the dev server drives the
   * same handlers from the `ws` package with this.
   */
  async function prepare(req: Request): Promise<unknown | Response> {
    // Origin gate (#52): reject a cross-site upgrade before authenticating, so a
    // malicious page can't open an authenticated duplex socket with the victim's
    // ambient credentials (cross-site WebSocket hijacking). Shares the handler's
    // policy so SSE/POST and WS enforce the same allowlist. Covers the dev-server
    // path too, which calls `prepare` directly.
    if (!handler.checkOrigin(req)) {
      handler.emitSecurity("origin-rejected", {
        origin: req.headers.get("origin"),
        path: new URL(req.url).pathname,
        transport: "ws",
      });
      return new Response("forbidden origin", { status: 403 });
    }
    const url = new URL(req.url);
    const { sid } = handler.resolveSid(req); // shared signed-cookie resolution (B2)
    let sessionData: unknown = {};
    if (opts.authenticate) {
      try {
        sessionData = await opts.authenticate(req, { sid });
      } catch (e) {
        return new Response(handler.safeErrorMessage(e, "forbidden"), { status: 403 }); // #9
      }
    }
    const data: WsData = {
      sid,
      sessionData,
      attach: {
        token: url.searchParams.get("attach"),
        seq: Number(url.searchParams.get("seq") ?? "-1"),
      },
      session: null,
    };
    return data;
  }

  /**
   * Returns `undefined` when the request isn't a WS upgrade (caller should
   * continue with HTTP handling), or a Response for failed upgrades. A
   * successful upgrade returns a 101-ish sentinel the adapter ignores.
   */
  async function handleUpgrade(
    req: Request,
    upgrade: ((data: unknown) => boolean) | undefined,
  ): Promise<Response | undefined> {
    const url = new URL(req.url);
    if (url.pathname !== "/__rpxd/ws" || !upgrade) return undefined;

    const prepared = await prepare(req);
    if (prepared instanceof Response) return prepared;
    if (upgrade(prepared)) {
      // Bun owns the connection now; no Response should be written.
      return new Response(null, { status: 101 });
    }
    return new Response("upgrade failed", { status: 400 });
  }

  return { websocket, handleUpgrade, prepare };
}
