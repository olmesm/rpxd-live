/**
 * `rpxd dev` (§14): ONE Bun process — Vite in middleware mode (HMR, codegen
 * watcher) + the rpxd runtime handler — on one port. Web-standard
 * Request/Response internally; node:http (under Bun) carries the bytes.
 */
import { existsSync } from "node:fs";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pathToFileURL } from "node:url";
import { createRpxdHandler, type RouteRegistration } from "@rpxd/server-bun";
import { rpxd as rpxdVitePlugin, runCodegen, scanRoutes } from "@rpxd/vite-plugin";
import { createServer as createViteServer } from "vite";
import type { RpxdConfig } from "./config.ts";
import { rpxdEntryPlugin } from "./entry.ts";
import { makeDevRender } from "./render.ts";

export interface DevServerOptions {
  /** Port to bind; 0 picks an ephemeral port. Default 3000. */
  port?: number;
}

export interface DevServer {
  port: number;
  close(): Promise<void>;
}

/** Convert a node request into a web `Request`, wiring abort on close. */
function toWebRequest(req: IncomingMessage, res: ServerResponse): Request {
  const url = `http://${req.headers.host ?? "localhost"}${req.url ?? "/"}`;
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (typeof value === "string") headers.set(key, value);
    else if (Array.isArray(value)) for (const v of value) headers.append(key, v);
  }
  const abort = new AbortController();
  res.on("close", () => abort.abort());
  const method = req.method ?? "GET";
  const hasBody = method !== "GET" && method !== "HEAD";
  return new Request(url, {
    method,
    headers,
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
  try {
    for await (const chunk of webRes.body as unknown as AsyncIterable<Uint8Array>) {
      res.write(chunk);
    }
  } catch {
    // client went away mid-stream (SSE disconnects land here)
  }
  res.end();
}

/**
 * Boot the dev shell for an rpxd app root.
 *
 * @example
 * ```ts
 * const server = await createDevServer(process.cwd(), { port: 3000 });
 * console.log(`live on :${server.port}`);
 * ```
 */
export async function createDevServer(
  rootDir: string,
  opts: DevServerOptions = {},
): Promise<DevServer> {
  const root = resolve(rootDir);

  // Config (§14): the only non-route file. Bun imports TS directly.
  const configPath = join(root, "rpxd.config.ts");
  const config: RpxdConfig = existsSync(configPath)
    ? ((await import(pathToFileURL(configPath).href)).default ?? {})
    : {};

  // Route codegen before anything imports .rpxd/routes.gen.ts (§7).
  runCodegen(root);

  const httpServer = createHttpServer();
  const vite = await createViteServer({
    root,
    appType: "custom",
    logLevel: "error",
    plugins: [rpxdVitePlugin(), rpxdEntryPlugin()],
    server: {
      middlewareMode: true,
      hmr: { server: httpServer },
    },
  });

  // Register live routes with the runtime (defs loaded via the SSR graph so
  // reducer edits flow through Vite's module invalidation).
  const entries = scanRoutes(join(root, "routes"));
  const routeFiles = new Map<string, string>();
  const routes: RouteRegistration[] = [];
  for (const entry of entries) {
    if (entry.kind !== "page" || entry.path === null) continue;
    routeFiles.set(entry.path, entry.file);
    const mod = await vite.ssrLoadModule(`/routes/${entry.file}`);
    routes.push({ path: entry.path, def: mod.default.def });
  }

  const handler = createRpxdHandler({
    routes,
    storage: config.storage,
    authenticate: config.session?.authenticate,
    render: makeDevRender(vite, routeFiles),
    defaultRateLimit: config.rateLimit,
  });

  httpServer.on("request", (req, res) => {
    const url = req.url ?? "/";
    if (url.startsWith("/__rpxd/")) {
      void handler
        .fetch(toWebRequest(req, res))
        .then((webRes) => writeWebResponse(res, webRes))
        .catch(() => {
          res.statusCode = 500;
          res.end("internal error");
        });
      return;
    }
    // Vite serves assets/transforms; unmatched URLs fall through to SSR.
    vite.middlewares(req, res, () => {
      void handler
        .fetch(toWebRequest(req, res))
        .then((webRes) => writeWebResponse(res, webRes))
        .catch(() => {
          res.statusCode = 500;
          res.end("internal error");
        });
    });
  });

  await new Promise<void>((resolveListen) =>
    httpServer.listen(opts.port ?? 3000, () => resolveListen()),
  );
  const { port } = httpServer.address() as AddressInfo;

  return {
    port,
    async close() {
      await handler.dispose();
      await vite.close();
      // Open SSE connections would otherwise hold close() forever.
      httpServer.closeAllConnections?.();
      await new Promise<void>((resolveClose) =>
        // vite.close() may have already closed the shared HMR server —
        // ERR_SERVER_NOT_RUNNING is fine.
        httpServer.close(() => resolveClose()),
      );
    },
  };
}
