/**
 * SSR rendering (§12): render props construction, HTML shell with the
 * `{ snapshot, seq, attachToken }` bootstrap, and the dev renderer (Vite SSR
 * module graph). The prod renderer in `start.ts` shares everything but the
 * module loading.
 */
import type { LiveRoute } from "@rpxd/core";
import { hydrateRscFields } from "@rpxd/rsc/client";
import type { RenderContext } from "@rpxd/server-bun";
import { createElement, type FunctionComponent, type ReactElement, type ReactNode } from "react";
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

/** Userland shell components (§14): __root wraps everything. */
export interface ShellComponents {
  Root?: FunctionComponent<{ children?: ReactNode }>;
  NotFound?: FunctionComponent<{ path: string }>;
  ErrorPage?: FunctionComponent<{ path: string; message: string }>;
}

/** Script/style URLs injected into the HTML shell. */
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

/**
 * Render one route component to a full HTML response.
 *
 * @example
 * ```ts
 * const html = renderRoute(route, { path: "/", instance, attachToken }, assets);
 * ```
 */
export function renderRoute(
  route: LiveRoute<unknown, string, unknown, FunctionComponent<object>>,
  ctx: RenderContext,
  assets: ShellAssets,
  opts: { rsc?: boolean; shell?: ShellComponents } = {},
): string {
  const props = serverRenderProps(ctx, opts.rsc ?? false);
  const page = createElement(route.component, props);
  const appHtml = renderToString(wrapWithRoot(page, opts.shell));
  return renderHtmlShell(ctx, appHtml, assets);
}

function wrapWithRoot(page: ReactElement, shell?: ShellComponents): ReactElement {
  return shell?.Root ? createElement(shell.Root, null, page) : page;
}

/** Render a static shell page (__404 / __error, §14) — no live state, no bootstrap. */
function renderStaticPage(
  element: ReactElement,
  status: number,
  shell?: ShellComponents,
): Response {
  const appHtml = renderToString(wrapWithRoot(element, shell));
  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>rpxd</title>
  </head>
  <body>
    <div id="root">${appHtml}</div>
  </body>
</html>`;
  return new Response(html, {
    status,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

/**
 * Build the handler's renderNotFound/renderError hooks from shell components (§14).
 *
 * @example
 * ```ts
 * const { renderNotFound, renderError } = makeShellRenderers(await loadShell(root));
 * ```
 */
export function makeShellRenderers(shell: ShellComponents) {
  return {
    renderNotFound: shell.NotFound
      ? (info: { path: string }) =>
          renderStaticPage(
            createElement(shell.NotFound as FunctionComponent<{ path: string }>, {
              path: info.path,
            }),
            404,
            shell,
          )
      : undefined,
    renderError: shell.ErrorPage
      ? (info: { path: string; error: unknown }) =>
          renderStaticPage(
            createElement(shell.ErrorPage as FunctionComponent<{ path: string; message: string }>, {
              path: info.path,
              message: info.error instanceof Error ? info.error.message : String(info.error),
            }),
            500,
            shell,
          )
      : undefined,
  };
}

/**
 * Build the dev SSR renderer over Vite's SSR module graph (§12).
 *
 * @example
 * ```ts
 * const render = makeDevRender(vite, routeFiles, { shell });
 * const response = await render({ path: "/", instance, attachToken });
 * ```
 */
export function makeDevRender(
  vite: ViteDevServer,
  routeFiles: Map<string, string>,
  opts: { rsc?: boolean; shell?: ShellComponents } = {},
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
