/**
 * `rpxd start` (§14): no Vite at runtime. Serves the client build statically,
 * SSRs from the server bundle, and runs the live wire through the same
 * `createRpxdHandler` as dev. Runtime-agnostic — `bunAdapter` under Bun,
 * `nodeAdapter` (`node:http`) under Node ≥ 24.
 */
import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { join, normalize, resolve } from "node:path";
import { Readable } from "node:stream";
import { pathToFileURL } from "node:url";
import { nodeAdapter } from "@rpxd/adapter-node";
import type { LiveRoute, RouteDefinition } from "@rpxd/core";
import {
  bunAdapter,
  createRpxdHandler,
  type HttpRouteRegistration,
  type RouteRegistration,
  type ServerAdapter,
  wsTransport,
} from "@rpxd/server-bun";
import type { FunctionComponent } from "react";
import { applyConfigOverrides, type ConfigOverrides, type RpxdConfig } from "./config.ts";
import type { ShellAssets, ShellComponents, SsrRuntime } from "./render.ts";

/** Options for {@link startApp}. */
export interface StartOptions {
  /** Port to bind; 0 picks an ephemeral port. Default 3000. */
  port?: number;
  /** CLI flag overrides (`--transport`, `--rsc`/`--no-rsc`) applied over the config. */
  overrides?: ConfigOverrides;
}

/** A running production server. */
export interface StartedApp {
  port: number;
  close(): Promise<void>;
}

interface ManifestChunk {
  file: string;
  css?: string[];
  isEntry?: boolean;
}

const CONTENT_TYPES: Record<string, string> = {
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

/** True when running on Bun; false under Node (`node:http` adapter). */
const isBun = typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";

/**
 * Stream a file as a web `Response`, working on both runtimes: `Bun.file`
 * under Bun, `fs.createReadStream` → web `ReadableStream` under Node.
 */
function fileResponse(filePath: string, headers: Record<string, string>): Response {
  if (isBun) return new Response(Bun.file(filePath), { headers });
  const body = Readable.toWeb(createReadStream(filePath)) as unknown as ReadableStream<Uint8Array>;
  return new Response(body, {
    headers: { ...headers, "content-length": String(statSync(filePath).size) },
  });
}

/**
 * Serve a built rpxd app (`rpxd build` output) with pure Bun.
 *
 * @example
 * ```ts
 * const app = await startApp(process.cwd(), { port: 3000 });
 * ```
 */
export async function startApp(rootDir: string, opts: StartOptions = {}): Promise<StartedApp> {
  const root = resolve(rootDir);
  const clientDir = join(root, "dist/client");
  const serverEntry = join(root, "dist/server/entry-server.js");
  if (!existsSync(serverEntry)) {
    throw new Error(`No server bundle at ${serverEntry} — run \`rpxd build\` first`);
  }

  const configPath = join(root, "rpxd.config.ts");
  const config: RpxdConfig = applyConfigOverrides(
    existsSync(configPath) ? ((await import(pathToFileURL(configPath).href)).default ?? {}) : {},
    opts.overrides,
  );

  // Route registry + SSR runtime from the server bundle — the bundle owns
  // rendering (§12); this process is pure transport.
  const serverEntryModule = (await import(
    pathToFileURL(serverEntry).href
  )) as unknown as SsrRuntime & {
    rootModule?: () => Promise<{ default: ShellComponents["Root"] }>;
    notFoundModule?: () => Promise<{ default: ShellComponents["NotFound"] }>;
    errorModule?: () => Promise<{ default: ShellComponents["ErrorPage"] }>;
  };
  const shell: ShellComponents = {
    Root: serverEntryModule.rootModule ? (await serverEntryModule.rootModule()).default : undefined,
    NotFound: serverEntryModule.notFoundModule
      ? (await serverEntryModule.notFoundModule()).default
      : undefined,
    ErrorPage: serverEntryModule.errorModule
      ? (await serverEntryModule.errorModule()).default
      : undefined,
  };
  const { routeModules } = serverEntryModule as unknown as {
    routeModules: Record<
      string,
      () => Promise<{ default: LiveRoute<unknown, string, unknown, FunctionComponent<object>> }>
    >;
  };
  // With rsc: true (§16), defs come from the react-server bundle so
  // handlers can Flight-serialize; components stay in the ssr bundle.
  let defModules = routeModules;
  if (config.rsc) {
    const rscEntry = join(root, "dist/rsc/index.js");
    if (!existsSync(rscEntry)) {
      throw new Error(`No react-server bundle at ${rscEntry} — run \`rpxd build\` first`);
    }
    ({ routeModules: defModules } = (await import(pathToFileURL(rscEntry).href)) as unknown as {
      routeModules: typeof routeModules;
    });
  }
  const routes: RouteRegistration[] = [];
  const components = new Map<
    string,
    LiveRoute<unknown, string, unknown, FunctionComponent<object>>
  >();
  for (const [path, load] of Object.entries(routeModules)) {
    const defLoad = defModules[path] ?? load;
    const route = (await load()).default;
    routes.push({ path, def: (await defLoad()).default.def });
    components.set(path, route);
  }

  // Server-only HTTP routes (`route()`) — from the ssr bundle; no component,
  // never SSR'd (the routes & auth guide).
  const { routeHandlers } = serverEntryModule as unknown as {
    routeHandlers?: Record<string, () => Promise<{ default: { def: RouteDefinition } }>>;
  };
  const httpRoutes: HttpRouteRegistration[] = [];
  for (const [path, load] of Object.entries(routeHandlers ?? {})) {
    httpRoutes.push({ path, def: (await load()).default.def });
  }

  // Hashed entry + css from the client manifest.
  const manifest = JSON.parse(
    readFileSync(join(clientDir, ".vite/manifest.json"), "utf-8"),
  ) as Record<string, ManifestChunk>;
  const entryChunk = Object.values(manifest).find((c) => c.isEntry);
  if (!entryChunk) throw new Error("No entry chunk in client manifest — rebuild");
  const assets: ShellAssets = {
    entrySrc: `/${entryChunk.file}`,
    css: entryChunk.css?.map((f) => `/${f}`),
  };

  const handler = createRpxdHandler({
    routes,
    httpRoutes,
    storage: config.storage,
    authenticate: config.session?.authenticate,
    defaultRateLimit: config.rateLimit,
    ...serverEntryModule.makeShellRenderers(shell),
    render: async (ctx) => {
      const route = components.get(ctx.path);
      if (!route) return new Response("not found", { status: 404 });
      const html = await serverEntryModule.renderRoute(route, ctx, assets, { rsc: config.rsc });
      return new Response(html, {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    },
  });

  const serveStatic = async (pathname: string): Promise<Response | null> => {
    const safe = normalize(pathname).replace(/^([/\\])+/, "");
    const filePath = join(clientDir, safe);
    if (!filePath.startsWith(clientDir) || !existsSync(filePath)) return null;
    const ext = filePath.slice(filePath.lastIndexOf("."));
    return fileResponse(filePath, {
      "content-type": CONTENT_TYPES[ext] ?? "application/octet-stream",
      "cache-control": "public, max-age=31536000, immutable",
    });
  };

  // WS transport opt-in (§11): same envelope protocol, duplex framing.
  const ws =
    config.transport?.kind === "ws"
      ? wsTransport(handler, { authenticate: config.session?.authenticate })
      : undefined;

  const adapter: ServerAdapter = isBun ? bunAdapter() : nodeAdapter();
  const handle = adapter.serve({
    port: opts.port ?? 3000,
    websocket: ws?.websocket,
    fetch: async (req, upgrade) => {
      if (ws) {
        const upgraded = await ws.handleUpgrade(req, upgrade);
        if (upgraded) {
          if (upgraded.status === 101) return undefined;
          return upgraded;
        }
      }
      const url = new URL(req.url);
      if (req.method === "GET" && url.pathname.includes(".")) {
        const asset = await serveStatic(url.pathname);
        if (asset) return asset;
        if (!url.pathname.startsWith("/__rpxd/")) return new Response("not found", { status: 404 });
      }
      return handler.fetch(req);
    },
  });
  // node:http binds on the next tick — await before reading the ephemeral port.
  await handle.ready;

  return {
    port: handle.port,
    async close() {
      await handler.dispose();
      await handle.stop();
    },
  };
}
