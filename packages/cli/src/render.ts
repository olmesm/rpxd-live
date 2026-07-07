/**
 * Dev SSR renderer (§12): loads the route module through Vite's SSR module
 * graph, renders the live component with server-side render props, and
 * emits the HTML shell with the `{ snapshot, seq, attachToken }` bootstrap.
 */
import type { LiveRoute } from "@rpxd/core";
import type { RenderContext } from "@rpxd/server-bun";
import { createElement, type FunctionComponent } from "react";
import { renderToString } from "react-dom/server";
import type { ViteDevServer } from "vite";
import { CLIENT_ENTRY_URL } from "./entry.ts";

/** Server-side render props: same shape the client hydrates with (§1). */
function serverRenderProps(ctx: RenderContext) {
  return {
    state: ctx.state,
    session: ctx.session ?? {},
    sync: { pending: false, inFlight: 0, errors: [] },
    status: "connecting" as const,
    keyOf: (id: string | number) => String(id),
    // rpcs fire from event handlers — inert during SSR
    rpc: new Proxy({}, { get: () => () => Promise.resolve() }),
    nav: { navigate: () => {}, patch: () => {} },
  };
}

export function makeDevRender(vite: ViteDevServer, routeFiles: Map<string, string>) {
  return async (ctx: RenderContext): Promise<Response> => {
    const file = routeFiles.get(ctx.path);
    if (!file) return new Response("not found", { status: 404 });

    const mod = await vite.ssrLoadModule(`/routes/${file}`);
    const route = mod.default as LiveRoute<unknown, string, unknown, FunctionComponent<object>>;
    const appHtml = renderToString(createElement(route.component, serverRenderProps(ctx)));

    const bootstrap = JSON.stringify({
      instance: ctx.instance,
      seq: ctx.seq,
      attachToken: ctx.attachToken,
      snapshot: { state: ctx.state, session: ctx.session },
      path: ctx.path,
      params: ctx.params,
    }).replaceAll("</", "<\\/");

    const raw = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>rpxd</title>
  </head>
  <body>
    <div id="root">${appHtml}</div>
    <script id="__rpxd" type="application/json">${bootstrap}</script>
    <script type="module" src="${CLIENT_ENTRY_URL}"></script>
  </body>
</html>`;

    // Injects the HMR client and any transformIndexHtml hooks.
    const html = await vite.transformIndexHtml(ctx.path, raw);
    return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
  };
}
