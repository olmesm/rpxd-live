/**
 * `rpxd start` (§14): pure Bun, no Vite at runtime. Serves the client build
 * statically, SSRs from the server bundle, and runs the live wire through
 * the same `createRpxdHandler` as dev.
 */
import { existsSync, readFileSync } from "node:fs";
import { join, normalize, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { LiveRoute } from "@rpxd/core";
import {
  bunAdapter,
  createRpxdHandler,
  type RouteRegistration,
  wsTransport,
} from "@rpxd/server-bun";
import type { FunctionComponent } from "react";
import type { RpxdConfig } from "./config.ts";
import {
  makeShellRenderers,
  renderRoute,
  type ShellAssets,
  type ShellComponents,
} from "./render.ts";

/** Options for {@link startApp}. */
export interface StartOptions {
  /** Port to bind; 0 picks an ephemeral port. Default 3000. */
  port?: number;
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
  const config: RpxdConfig = existsSync(configPath)
    ? ((await import(pathToFileURL(configPath).href)).default ?? {})
    : {};

  // Route registry from the SSR bundle.
  const serverEntryModule = (await import(pathToFileURL(serverEntry).href)) as unknown as {
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
  const routes: RouteRegistration[] = [];
  const components = new Map<
    string,
    LiveRoute<unknown, string, unknown, FunctionComponent<object>>
  >();
  for (const [path, load] of Object.entries(routeModules)) {
    const route = (await load()).default;
    routes.push({ path, def: route.def });
    components.set(path, route);
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
    storage: config.storage,
    authenticate: config.session?.authenticate,
    defaultRateLimit: config.rateLimit,
    ...makeShellRenderers(shell),
    render: (ctx) => {
      const route = components.get(ctx.path);
      if (!route) return new Response("not found", { status: 404 });
      return new Response(renderRoute(route, ctx, assets, { rsc: config.rsc }), {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    },
  });

  const serveStatic = async (pathname: string): Promise<Response | null> => {
    const safe = normalize(pathname).replace(/^([/\\])+/, "");
    const filePath = join(clientDir, safe);
    if (!filePath.startsWith(clientDir) || !existsSync(filePath)) return null;
    const ext = filePath.slice(filePath.lastIndexOf("."));
    const file = Bun.file(filePath);
    return new Response(file, {
      headers: {
        "content-type": CONTENT_TYPES[ext] ?? "application/octet-stream",
        "cache-control": "public, max-age=31536000, immutable",
      },
    });
  };

  // WS transport opt-in (§11): same envelope protocol, duplex framing.
  const ws =
    config.transport?.kind === "ws"
      ? wsTransport(handler, { authenticate: config.session?.authenticate })
      : undefined;

  const handle = bunAdapter().serve({
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

  return {
    port: handle.port,
    async close() {
      await handler.dispose();
      await handle.stop();
    },
  };
}
