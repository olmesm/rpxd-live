/**
 * WS transport glue (§11 `transport: ws()`): one duplex socket carrying the
 * same envelopes/batches as SSE+POST — the protocol is transport-agnostic,
 * only framing differs (`docs/protocol.md`).
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

const SID_COOKIE = "rpxd_sid";

function sidOf(req: Request): string {
  const cookie = req.headers.get("cookie") ?? "";
  const found = cookie
    .split(";")
    .map((c) => c.trim())
    .find((c) => c.startsWith(`${SID_COOKIE}=`));
  return found ? found.slice(SID_COOKIE.length + 1) : crypto.randomUUID();
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
  opts: { authenticate?: (req: Request) => unknown | Promise<unknown> } = {},
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

    let sessionData: unknown = {};
    if (opts.authenticate) {
      try {
        sessionData = await opts.authenticate(req);
      } catch (e) {
        return new Response(e instanceof Error ? e.message : "forbidden", { status: 403 });
      }
    }
    const data: WsData = {
      sid: sidOf(req),
      sessionData,
      attach: {
        token: url.searchParams.get("attach"),
        seq: Number(url.searchParams.get("seq") ?? "-1"),
      },
      session: null,
    };
    if (upgrade(data)) {
      // Bun owns the connection now; no Response should be written.
      return new Response(null, { status: 101 });
    }
    return new Response("upgrade failed", { status: 400 });
  }

  return { websocket, handleUpgrade };
}
