/**
 * SSR rendering (§12): render props construction, HTML shell with the
 * `{ snapshot, seq, attachToken }` bootstrap, and the dev renderer (Vite SSR
 * module graph). The prod renderer in `start.ts` shares everything but the
 * module loading.
 */
import type { LiveRoute } from "@rpxd/core";
import { hydrateRscFields } from "@rpxd/rsc/client";
import type { RenderContext } from "@rpxd/server-bun";
import { createElement, type FunctionComponent } from "react";
import { renderToString } from "react-dom/server";
import type { ViteDevServer } from "vite";
import { CLIENT_ENTRY_URL } from "./entry.ts";

/** Server-side render props: same shape the client hydrates with (§1). */
function serverRenderProps(ctx: RenderContext, rsc: boolean) {
  return {
    state: rsc ? hydrateRscFields(ctx.state) : ctx.state,
    session: ctx.session ?? {},
    sync: { pending: false, inFlight: 0, errors: [] },
    status: "connecting" as const,
    keyOf: (id: string | number) => String(id),
    // rpcs fire from event handlers — inert during SSR
    rpc: new Proxy({}, { get: () => () => Promise.resolve() }),
    nav: { navigate: () => {}, patch: () => {} },
  };
}

export interface ShellAssets {
  /** Client entry script URL (virtual in dev, hashed asset in prod). */
  entrySrc: string;
  /** Stylesheet URLs emitted by the client build. */
  css?: string[];
}

/** Compose the HTML shell around a server-rendered app (§12 bootstrap contract). */
function renderHtmlShell(ctx: RenderContext, appHtml: string, assets: ShellAssets): string {
  const bootstrap = JSON.stringify({
    instance: ctx.instance,
    seq: ctx.seq,
    attachToken: ctx.attachToken,
    snapshot: { state: ctx.state, session: ctx.session },
    path: ctx.path,
    params: ctx.params,
  }).replaceAll("</", "<\\/");

  const links = (assets.css ?? [])
    .map((href) => `    <link rel="stylesheet" href="${href}" />`)
    .join("\n");

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>rpxd</title>
${links}
  </head>
  <body>
    <div id="root">${appHtml}</div>
    <script id="__rpxd" type="application/json">${bootstrap}</script>
    <script type="module" src="${assets.entrySrc}"></script>
  </body>
</html>`;
}

/** Render one route component to a full HTML response. */
export function renderRoute(
  route: LiveRoute<unknown, string, unknown, FunctionComponent<object>>,
  ctx: RenderContext,
  assets: ShellAssets,
  opts: { rsc?: boolean } = {},
): string {
  const props = serverRenderProps(ctx, opts.rsc ?? false);
  const appHtml = renderToString(createElement(route.component, props));
  return renderHtmlShell(ctx, appHtml, assets);
}

export function makeDevRender(
  vite: ViteDevServer,
  routeFiles: Map<string, string>,
  opts: { rsc?: boolean } = {},
) {
  return async (ctx: RenderContext): Promise<Response> => {
    const file = routeFiles.get(ctx.path);
    if (!file) return new Response("not found", { status: 404 });

    const mod = await vite.ssrLoadModule(`/routes/${file}`);
    const route = mod.default as LiveRoute<unknown, string, unknown, FunctionComponent<object>>;
    const raw = renderRoute(route, ctx, { entrySrc: CLIENT_ENTRY_URL }, opts);

    // Injects the HMR client and any transformIndexHtml hooks.
    const html = await vite.transformIndexHtml(ctx.path, raw);
    return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
  };
}
