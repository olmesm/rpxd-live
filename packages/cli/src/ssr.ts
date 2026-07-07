/**
 * Graph-side SSR runtime (§12): render props construction, the streaming
 * page renderer, and the static shell pages. This module runs INSIDE the
 * server module graph — the Vite `ssr` environment in dev, bundled into
 * `dist/server/entry-server.js` for prod — so `rpxd dev`/`rpxd start` stay
 * pure transport and RSC-field deserialization (§16) can reach the plugin's
 * environment-scoped modules.
 *
 * Rendering always streams (`react-dom/server.edge`): identical output for
 * non-suspending trees, and resolving Flight client references (§16 step 2)
 * suspends — which `renderToString` cannot do.
 */
import type { LiveRoute } from "@rpxd/core";
import { configureRscRuntime, flightStream, hydrateRscFields } from "@rpxd/rsc/client";
import type { RenderContext } from "@rpxd/server-bun";
import { createElement, type FunctionComponent, type ReactElement, type ReactNode } from "react";
import { renderToReadableStream } from "react-dom/server.edge";

let flightRuntimeReady: Promise<void> | undefined;

/** Install the server-graph Flight deserializer once (§16). */
function ensureFlightRuntime(): Promise<void> {
  flightRuntimeReady ??= import("@vitejs/plugin-rsc/ssr").then(({ createFromReadableStream }) => {
    configureRscRuntime((payload) => createFromReadableStream(flightStream(payload)));
  });
  return flightRuntimeReady;
}

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

/** Render an element to a complete HTML string via the streaming renderer. */
async function streamToHtml(element: ReactElement): Promise<string> {
  const stream = await renderToReadableStream(element);
  await stream.allReady;
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let html = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    html += decoder.decode(value, { stream: true });
  }
  return html;
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

function wrapWithRoot(page: ReactElement, shell?: ShellComponents): ReactElement {
  return shell?.Root ? createElement(shell.Root, null, page) : page;
}

/**
 * Render one route component to a full HTML document (streaming, §12).
 *
 * @example
 * ```ts
 * const html = await renderRoute(route, ctx, assets, { shell });
 * ```
 */
export async function renderRoute(
  route: LiveRoute<unknown, string, unknown, FunctionComponent<object>>,
  ctx: RenderContext,
  assets: ShellAssets,
  opts: { rsc?: boolean; shell?: ShellComponents } = {},
): Promise<string> {
  if (opts.rsc) await ensureFlightRuntime();
  const props = serverRenderProps(ctx, opts.rsc ?? false);
  const page = createElement(route.component, props);
  const appHtml = await streamToHtml(wrapWithRoot(page, opts.shell));
  return renderHtmlShell(ctx, appHtml, assets);
}

/** Render a static shell page (__404 / __error, §14) — no live state, no bootstrap. */
async function renderStaticPage(
  element: ReactElement,
  status: number,
  shell?: ShellComponents,
): Promise<Response> {
  const appHtml = await streamToHtml(wrapWithRoot(element, shell));
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
 * Build the handler's renderNotFound/renderError hooks from shell components
 * (§14). In `"prod"` mode (the default) the error page receives a generic
 * message with a ref id and the real error goes to the server log — never
 * the wire (§10). `"dev"` passes the real message through.
 *
 * @example
 * ```ts
 * const { renderNotFound, renderError } = makeShellRenderers(shell);
 * ```
 */
export function makeShellRenderers(shell: ShellComponents, opts: { mode?: "dev" | "prod" } = {}) {
  const mode = opts.mode ?? "prod";
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
      ? (info: { path: string; error: unknown }) => {
          let message = info.error instanceof Error ? info.error.message : String(info.error);
          if (mode === "prod") {
            const ref = crypto.randomUUID().slice(0, 8);
            console.error(`[rpxd] error ${ref} at ${info.path}:`, info.error);
            message = `Internal error (ref: ${ref})`;
          }
          return renderStaticPage(
            createElement(shell.ErrorPage as FunctionComponent<{ path: string; message: string }>, {
              path: info.path,
              message,
            }),
            500,
            shell,
          );
        }
      : undefined,
  };
}
