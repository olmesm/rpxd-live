/**
 * Node `ServerAdapter` (§13, §14): `node:http` carrying the web-standard rpxd
 * runtime handler, with WebSocket upgrades bridged through the `ws` package.
 *
 * The runtime is web-standard (`Request`/`Response`/`ReadableStream`) with no
 * Bun types past the {@link ServerAdapter} boundary, so this adapter is the
 * `node:http` mirror of {@link bunAdapter}: the same `toWebRequest` /
 * `writeWebResponse` bridge the dev server already uses. Pair it with
 * `@rpxd/storage-sqlite/node` (`better-sqlite3`) for durable snapshots.
 *
 * Requires Node ≥ 24 (stable, unflagged TypeScript execution); works on Node
 * 22.18+ where type-stripping is also unflagged.
 *
 * @packageDocumentation
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";
import type { ServeHandle, ServeOptions, ServerAdapter, SocketLike } from "@rpxd/server-bun";
import { WebSocketServer } from "ws";

export type { ServeHandle, ServeOptions, ServerAdapter } from "@rpxd/server-bun";

function headersOf(req: IncomingMessage): Headers {
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (typeof value === "string") headers.set(key, value);
    else if (Array.isArray(value)) for (const v of value) headers.append(key, v);
  }
  return headers;
}

/** Convert a node request into a web `Request`, wiring abort on close. */
function toWebRequest(req: IncomingMessage, res: ServerResponse): Request {
  const url = `http://${req.headers.host ?? "localhost"}${req.url ?? "/"}`;
  const abort = new AbortController();
  res.on("close", () => abort.abort());
  const method = req.method ?? "GET";
  const hasBody = method !== "GET" && method !== "HEAD";
  return new Request(url, {
    method,
    headers: headersOf(req),
    signal: abort.signal,
    ...(hasBody
      ? {
          body: Readable.toWeb(req) as unknown as ReadableStream<Uint8Array>,
          duplex: "half",
        }
      : {}),
  });
}

/** Stream a web `Response` back through the node response. */
async function writeWebResponse(res: ServerResponse, webRes: Response): Promise<void> {
  res.statusCode = webRes.status;
  for (const [key, value] of webRes.headers) {
    if (key === "set-cookie") continue;
    res.setHeader(key, value);
  }
  const cookies = webRes.headers.getSetCookie?.() ?? [];
  if (cookies.length > 0) res.setHeader("set-cookie", cookies);
  if (!webRes.body) {
    res.end();
    return;
  }
  const reader = webRes.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(value);
    }
  } catch {
    // client went away mid-stream (SSE disconnects land here)
  }
  res.end();
}

/**
 * Node implementation of {@link ServerAdapter} — `node:http` for HTTP/SSE and
 * the `ws` package (noServer) for the §11 `transport: ws()` upgrade, both on
 * one port. The mirror of {@link bunAdapter}.
 *
 * @example
 * ```ts
 * const handle = nodeAdapter().serve({ port: 3000, fetch: handler.fetch });
 * ```
 */
export function nodeAdapter(): ServerAdapter {
  return {
    serve({ port = 3000, hostname, fetch, websocket }: ServeOptions): ServeHandle {
      const server = createServer((req, res) => {
        void Promise.resolve(fetch(toWebRequest(req, res), undefined))
          .then(async (webRes) => {
            if (webRes) await writeWebResponse(res, webRes);
            else res.end();
          })
          .catch((e) => {
            console.error("[rpxd] request failed:", e);
            res.statusCode = 500;
            res.end("internal error");
          });
      });

      // §11 `transport: ws()`: upgrades arrive on the `upgrade` event (never
      // the request handler), so route them through the same
      // `fetch(req, upgrade)` contract Bun.serve exposes — `upgrade(data)`
      // hands the connection to the `ws` package and wires the socket handlers.
      let wss: WebSocketServer | undefined;
      if (websocket) {
        wss = new WebSocketServer({ noServer: true });
        server.on("upgrade", (req, socket, head) => {
          const webReq = new Request(`http://${req.headers.host ?? "localhost"}${req.url ?? "/"}`, {
            headers: headersOf(req),
          });
          let upgraded = false;
          const upgrade = (data: unknown): boolean => {
            upgraded = true;
            wss?.handleUpgrade(req, socket, head, (client) => {
              const socketLike: SocketLike = {
                data,
                send: (message: string) => client.send(message),
                close: () => client.close(),
              };
              websocket.open?.(socketLike);
              client.on("message", (raw) => websocket.message?.(socketLike, String(raw)));
              client.on("close", () => websocket.close?.(socketLike));
            });
            return true;
          };
          void Promise.resolve(fetch(webReq, upgrade))
            .then((res) => {
              if (upgraded) return; // ws owns the connection now
              // fetch declined the upgrade (e.g. auth 403, or not our path).
              const status = res?.status ?? 400;
              socket.write(`HTTP/1.1 ${status}\r\nconnection: close\r\n\r\n`);
              socket.destroy();
            })
            .catch((e) => {
              console.error("[rpxd] ws upgrade failed:", e);
              socket.destroy();
            });
        });
      }

      const ready = new Promise<void>((resolveReady) => {
        server.once("listening", () => resolveReady());
      });
      server.listen(port, hostname);
      return {
        ready,
        get port() {
          const addr = server.address() as AddressInfo | null;
          return addr?.port ?? port;
        },
        async stop() {
          wss?.close();
          for (const client of wss?.clients ?? []) client.terminate();
          // Force keep-alive/SSE connections closed so `close` can resolve.
          server.closeAllConnections?.();
          await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
        },
      };
    },
    env: (name) => process.env[name],
  };
}
