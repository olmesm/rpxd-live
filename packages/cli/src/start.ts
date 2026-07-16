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
  makeDiagnosticEmit,
  type RouteRegistration,
  type ServerAdapter,
  wsTransport,
} from "@rpxd/server-bun";
import { assertLiveModule } from "@rpxd/vite-plugin";
import type { FunctionComponent } from "react";
import {
  applyConfigOverrides,
  type ConfigOverrides,
  configSlotRegistrations,
  instanceHandlerOptions,
  propagateSessionSecretEnv,
  type RpxdConfig,
} from "./config.ts";
import type { ShellAssets, ShellComponents, SsrRuntime } from "./render.ts";
import { installUnhandledRejectionGuard, runCloseSequence } from "./shutdown.ts";

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
  /** Resolved summary the CLI banner announces: transport/rsc and route count. */
  info: { transport: "sse" | "ws"; rsc: boolean; routes: number };
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

  // Secret propagation (§16, #95): rsc() (react-server bundle) and the SSR
  // verifier (packages/cli/src/ssr.ts) run in separate module graphs in this
  // one process — RPXD_SESSION_SECRET is the only channel between them. Must
  // run before the server/rsc bundles are imported below.
  propagateSessionSecretEnv(config);

  // Process-owner backstop (item 5): any FUTURE detached rejection (framework
  // or app code — rpxd's own dispatch boundary is already total, #112) is
  // reported through the app's configured sink rather than crashing silently.
  installUnhandledRejectionGuard(makeDiagnosticEmit(config.onDiagnostic));

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
    // Carry the props schema (ADR 0002) from the built LiveRoute onto the
    // registration so the handler can decode+validate `?query` props before
    // guard/load. `undefined` for schema-less routes (raw-string back-compat).
    routes.push({ path, def: (await defLoad()).default.def, props: route.props });
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

  // Mount-only slots (ADR 0002 item 6): the server bundle re-exports the
  // scan's `.rpxd/live.gen.ts` importers. `assertLiveModule` fails a scan
  // false-positive at boot (not first mount); the config `slots` escape hatch
  // adds library-shipped objects the scan can't see. Both feed the same
  // control-plane mount union — the handler asserts pattern uniqueness across it.
  // (Slots aren't SSR-served, so their defs load from the ssr bundle even under
  // rsc; render-driven SSR discovery for slots is a documented follow-up.)
  const { liveModules } = serverEntryModule as unknown as {
    liveModules?: Record<string, () => Promise<unknown>>;
  };
  const slots: RouteRegistration[] = [];
  for (const [pattern, load] of Object.entries(liveModules ?? {})) {
    const mod = assertLiveModule(await load(), pattern);
    slots.push({
      path: mod.path,
      def: mod.def as RouteRegistration["def"],
      props: mod.props as RouteRegistration["props"],
    });
  }
  slots.push(...configSlotRegistrations(config));

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
    slots,
    httpRoutes,
    storage: config.storage,
    authenticate: config.session?.authenticate,
    allowedOrigins: config.allowedOrigins,
    cookie: config.session?.cookie, // Secure by default (B1); prod is HTTPS
    sessionSecret: config.session?.secret, // HMAC-signs the sid (B2); env fallback in handler
    defaultRateLimit: config.rateLimit,
    throttle: config.throttle,
    ...instanceHandlerOptions(config),
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
    info: {
      transport: config.transport?.kind ?? "sse",
      rsc: config.rsc === true,
      routes: routes.length + httpRoutes.length,
    },
    // Ordered graceful shutdown: stop taking new connections, flush every warm
    // instance's snapshot to storage (§11), run the app's own cleanup, then
    // close the storage rpxd owns. Ordering matters — dispose writes snapshots,
    // so storage must still be open for it, and `onShutdown` runs before we
    // close storage in case the app touches it.
    close: () =>
      runCloseSequence({
        stop: () => handle.stop(),
        dispose: () => handler.dispose(),
        onShutdown: config.onShutdown,
        closeStorage: config.storage?.close?.bind(config.storage),
      }),
  };
}
