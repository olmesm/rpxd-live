/**
 * `ServerAdapter` seam (§14): web-standard `Request`/`Response` internally,
 * no Bun types past this boundary — a Node adapter later is ~100 lines.
 */

/** A running server. */
export interface ServeHandle {
  port: number;
  stop(): void | Promise<void>;
  /**
   * Resolves once the listener is bound. Bun binds synchronously so `port` is
   * readable immediately; `node:http` binds on the next tick, so the Node
   * adapter only knows an ephemeral (`port: 0`) port after this resolves.
   * Await it before reading `port` when the requested port may be `0`.
   */
  ready?: Promise<void>;
}

/** Minimal duplex socket surface the runtime needs (§11 ws opt-in). */
export interface SocketLike<T = unknown> {
  data: T;
  send(message: string): void;
  close(): void;
  /**
   * Bytes queued on the socket but not yet flushed to the peer — the egress
   * byte budget's measure (§11 slow-consumer guard; `maxBufferedBytes`).
   * Bun's `ServerWebSocket` provides it natively; the Node adapter maps it to
   * the `ws` package's `bufferedAmount`. Optional: without it the budget is
   * simply unenforced on that socket (never a false kill).
   */
  getBufferedAmount?(): number;
}

/** Socket lifecycle callbacks for the ws transport (§11). */
export interface WebSocketHandlers<T = unknown> {
  open?(socket: SocketLike<T>): void;
  message?(socket: SocketLike<T>, message: string): void;
  close?(socket: SocketLike<T>): void;
}

/** Listener options for {@link ServerAdapter.serve}. */
export interface ServeOptions {
  port?: number;
  hostname?: string;
  /**
   * Request handler. `upgrade` is provided when `websocket` handlers are
   * configured: call it to take the connection duplex; it returns true when
   * the upgrade succeeded (return no Response in that case).
   */
  fetch(
    req: Request,
    upgrade?: (data: unknown) => boolean,
  ): Response | undefined | Promise<Response | undefined>;
  websocket?: WebSocketHandlers;
}

/**
 * The runtime seam rpxd serves through (§14). `serve` binds the HTTP
 * listener (with optional WS upgrade — §11 `transport: ws()`), `env` reads
 * configuration.
 */
export interface ServerAdapter {
  serve(opts: ServeOptions): ServeHandle;
  env(name: string): string | undefined;
}

/**
 * Bun implementation of {@link ServerAdapter} — `Bun.serve`, HTTP (+ WS
 * later) on one port (§14).
 *
 * @example
 * ```ts
 * const handle = bunAdapter().serve({ port: 3000, fetch: handler.fetch });
 * ```
 */
export function bunAdapter(): ServerAdapter {
  return {
    serve({ port = 3000, hostname, fetch, websocket }) {
      const server = Bun.serve<unknown>({
        port,
        hostname,
        async fetch(req, bunServer) {
          const upgrade = websocket
            ? (data: unknown) => bunServer.upgrade(req, { data })
            : undefined;
          const res = await fetch(req, upgrade);
          // undefined response = successful upgrade; Bun takes over.
          return res as Response;
        },
        websocket: {
          open(ws) {
            websocket?.open?.(ws as unknown as SocketLike);
          },
          message(ws, message) {
            websocket?.message?.(ws as unknown as SocketLike, String(message));
          },
          close(ws) {
            websocket?.close?.(ws as unknown as SocketLike);
          },
        },
      });
      return {
        port: server.port ?? port,
        stop: () => server.stop(true),
      };
    },
    env: (name) => process.env[name],
  };
}
