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
import type { RouteDefinition } from "@rpxd/core";
import {
  createRpxdHandler,
  type HttpRouteRegistration,
  type RouteRegistration,
  wsTransport,
} from "@rpxd/server-bun";
import { fileToRoute, rpxd as rpxdVitePlugin, runCodegen, scanRoutes } from "@rpxd/vite-plugin";
import rscFlightPlugin from "@vitejs/plugin-rsc";
import { createServerModuleRunner, createServer as createViteServer } from "vite";
import { WebSocketServer } from "ws";
import { applyConfigOverrides, type ConfigOverrides, type RpxdConfig } from "./config.ts";
import { rpxdEntryPlugin } from "./entry.ts";
import { nodeRequestUrl } from "./http-bridge.ts";
import {
  loadSsrRuntime,
  makeDevRender,
  renderDevErrorPage,
  type ShellComponents,
} from "./render.ts";

/** Options for {@link createDevServer}. */
export interface DevServerOptions {
  /** Port to bind; 0 picks an ephemeral port. Default 3000. */
  port?: number;
  /** CLI flag overrides (`--transport`, `--rsc`/`--no-rsc`) applied over the config. */
  overrides?: ConfigOverrides;
}

/** A running dev shell. */
export interface DevServer {
  port: number;
  close(): Promise<void>;
}

function headersOf(req: IncomingMessage): Headers {
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (typeof value === "string") headers.set(key, value);
    else if (Array.isArray(value)) for (const v of value) headers.append(key, v);
  }
  return headers;
}

/**
 * Convert a node request into a web `Request`, wiring abort on close. Returns
 * `null` when the request line / `Host` is malformed enough that URL parsing
 * throws — the caller answers 400 rather than letting the exception crash the
 * dev server process.
 */
function toWebRequest(req: IncomingMessage, res: ServerResponse): Request | null {
  const url = nodeRequestUrl(req);
  if (!url) return null;
  const headers = headersOf(req);
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
  const config: RpxdConfig = applyConfigOverrides(
    existsSync(configPath) ? ((await import(pathToFileURL(configPath).href)).default ?? {}) : {},
    opts.overrides,
  );

  // Route codegen before anything imports .rpxd/routes.gen.ts (§7).
  runCodegen(root);

  const httpServer = createHttpServer();
  // Reducer HMR (§15): when a route file changes, reload its module through
  // the SSR graph and swap the def into the running handler — instance state
  // is preserved. handleHotUpdate fires after Vite invalidates the module.
  let onRouteFileChange: ((file: string) => void) | undefined;
  const reducerHmrPlugin = {
    name: "rpxd-reducer-hmr",
    handleHotUpdate(hmrCtx: { file: string }) {
      onRouteFileChange?.(hmrCtx.file);
    },
  };
  const vite = await createViteServer({
    root,
    appType: "custom",
    logLevel: "error",
    plugins: [
      rpxdVitePlugin(),
      rpxdEntryPlugin({ rsc: config.rsc, transport: config.transport?.kind }),
      reducerHmrPlugin,
      // Flight runtime (§16): the plugin only contributes environments —
      // rpxd owns the request loop.
      ...(config.rsc ? [rscFlightPlugin({ serverHandler: false })] : []),
    ],
    // The deserializing half of @rpxd/rsc picks its runtime via
    // import.meta.env.SSR — it must stay inside the graph (§16).
    ssr: { noExternal: ["@rpxd/rsc"] },
    // One plugin instance everywhere: @rpxd/rsc's dynamic imports must
    // resolve to the same copy the registered plugin serves virtuals for.
    resolve: config.rsc ? { dedupe: ["@vitejs/plugin-rsc"] } : undefined,
    environments: config.rsc ? { rsc: { resolve: { noExternal: ["@rpxd/rsc"] } } } : undefined,
    server: {
      middlewareMode: true,
      hmr: { server: httpServer },
    },
  });

  // Defs come from the react-server graph when rsc is on (§16): handlers run
  // under the react-server condition so rsc() can Flight-serialize. Page
  // components keep loading through the ssr graph for SSR.
  const rscRunner =
    config.rsc && vite.environments.rsc
      ? createServerModuleRunner(vite.environments.rsc)
      : undefined;
  const loadDefModule = (file: string): Promise<{ default: { def: unknown } }> =>
    rscRunner
      ? rscRunner.import(`/routes/${file}`)
      : (vite.ssrLoadModule(`/routes/${file}`) as Promise<{ default: { def: unknown } }>);

  // Register live routes with the runtime (defs loaded via the server graph
  // so reducer edits flow through Vite's module invalidation).
  const entries = scanRoutes(join(root, "routes"));
  const routeFiles = new Map<string, string>();
  const routes: RouteRegistration[] = [];
  const httpRoutes: HttpRouteRegistration[] = [];
  const shell: ShellComponents = {};
  for (const entry of entries) {
    if (entry.kind === "page" && entry.path !== null) {
      routeFiles.set(entry.path, entry.file);
      const mod = await loadDefModule(entry.file);
      routes.push({ path: entry.path, def: mod.default.def } as RouteRegistration);
      continue;
    }
    if (entry.kind === "http" && entry.path !== null) {
      // HTTP routes (`route()`) run in the plain server graph, not react-server.
      const mod = await vite.ssrLoadModule(`/routes/${entry.file}`);
      httpRoutes.push({ path: entry.path, def: (mod.default as { def: RouteDefinition }).def });
      continue;
    }
    // Shell files (§14): __root / __404 / __error
    const mod = await vite.ssrLoadModule(`/routes/${entry.file}`);
    if (entry.kind === "root") shell.Root = mod.default;
    if (entry.kind === "notFound") shell.NotFound = mod.default;
    if (entry.kind === "error") shell.ErrorPage = mod.default;
  }

  const routesDir = join(root, "routes");
  // The SSR runtime renders in-graph (§12) — same graph the routes load in.
  const ssrRuntime = await loadSsrRuntime(vite);
  const handler = createRpxdHandler({
    routes,
    httpRoutes,
    storage: config.storage,
    authenticate: config.session?.authenticate,
    allowedOrigins: config.allowedOrigins,
    // Dev is served over HTTP (localhost or a LAN IP), so default the sid cookie
    // to non-Secure unless the app opts in — otherwise a phone on the LAN never
    // gets a session (B1). Prod (`start`) keeps the Secure default.
    cookie: config.session?.cookie ?? { secure: false },
    sessionSecret: config.session?.secret, // HMAC-signs the sid (B2); env fallback in handler
    throttle: config.throttle, // respect the configured throttle in dev too (#6)
    debugErrors: true, // dev: surface crash details to the client (#9)
    render: makeDevRender(vite, routeFiles, { rsc: config.rsc, shell }),
    ...ssrRuntime.makeShellRenderers(shell, { mode: "dev" }),
    // Dev overlay (§14): runtime errors render the framework page with the
    // real message and a sourcemapped stack instead of the app __error page.
    renderError: (info: { path: string; error: unknown }) => {
      if (info.error instanceof Error) vite.ssrFixStacktrace(info.error);
      return renderDevErrorPage(info.path, info.error);
    },
    defaultRateLimit: config.rateLimit,
  });

  onRouteFileChange = (file) => {
    if (!file.startsWith(routesDir)) return;
    const entry = fileToRoute(file.slice(routesDir.length + 1));
    if (!entry || entry.kind !== "page" || entry.path === null) return;
    const routePath = entry.path;
    routeFiles.set(routePath, entry.file);
    void loadDefModule(entry.file)
      .then((mod) => {
        handler.updateRoute(
          routePath,
          mod.default.def as Parameters<typeof handler.updateRoute>[1],
        );
      })
      .catch((e) => console.error("[rpxd] reducer HMR reload failed:", e));
  };

  // Dev-mode WS transport (§11, dev/prod parity): the `ws` package in
  // noServer mode drives the same wsTransport handlers Bun.serve uses.
  // Vite's HMR socket shares the port — only /__rpxd/ws upgrades are ours.
  const wsGlue = wsTransport(handler, { authenticate: config.session?.authenticate });
  const wss = new WebSocketServer({ noServer: true });
  httpServer.on("upgrade", (req, rawSocket, head) => {
    const urlStr = nodeRequestUrl(req);
    if (!urlStr) {
      rawSocket.write("HTTP/1.1 400 Bad Request\r\nconnection: close\r\n\r\n");
      rawSocket.destroy();
      return;
    }
    const url = new URL(urlStr);
    if (url.pathname !== "/__rpxd/ws") return; // Vite HMR and friends
    void (async () => {
      const prepared = await wsGlue.prepare(new Request(url, { headers: headersOf(req) }));
      if (prepared instanceof Response) {
        rawSocket.write(`HTTP/1.1 ${prepared.status} Forbidden\r\nconnection: close\r\n\r\n`);
        rawSocket.destroy();
        return;
      }
      wss.handleUpgrade(req, rawSocket, head, (client) => {
        const socketLike = {
          data: prepared,
          send: (message: string) => client.send(message),
          close: () => client.close(),
        };
        wsGlue.websocket.open?.(socketLike);
        client.on("message", (raw) => wsGlue.websocket.message?.(socketLike, String(raw)));
        client.on("close", () => wsGlue.websocket.close?.(socketLike));
      });
    })().catch((e) => {
      console.error("[rpxd] ws upgrade failed:", e);
      rawSocket.destroy();
    });
  });

  httpServer.on("request", (req, res) => {
    const url = req.url ?? "/";
    if (url.startsWith("/__rpxd/")) {
      const webReq = toWebRequest(req, res);
      if (!webReq) {
        res.statusCode = 400;
        res.end("bad request");
        return;
      }
      void handler
        .fetch(webReq)
        .then((webRes) => writeWebResponse(res, webRes))
        .catch((e) => {
          console.error("[rpxd] request failed:", e);
          res.statusCode = 500;
          res.end("internal error");
        });
      return;
    }
    // Vite serves assets/transforms; unmatched URLs fall through to SSR.
    vite.middlewares(req, res, () => {
      const webReq = toWebRequest(req, res);
      if (!webReq) {
        res.statusCode = 400;
        res.end("bad request");
        return;
      }
      void handler
        .fetch(webReq)
        .then((webRes) => writeWebResponse(res, webRes))
        .catch((e) => {
          console.error("[rpxd] request failed:", e);
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
      for (const client of wss.clients) client.terminate();
      wss.close();
      // The react-server module runner holds an HMR channel open (§16).
      await rscRunner?.close();
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
