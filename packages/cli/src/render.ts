/**
 * CLI-space rendering glue (§12, §14): the dev renderer wrapper (loads the
 * graph-side SSR runtime through Vite) and the framework dev error page.
 * The actual React rendering lives in `./ssr.ts`, which runs inside the
 * server module graph — see that module for why.
 */
import type { LiveRoute } from "@rpxd/core";
import type { RenderContext } from "@rpxd/server-bun";
import type { FunctionComponent } from "react";
import type { ViteDevServer } from "vite";
import { CLIENT_ENTRY_URL, SSR_RUNTIME_URL } from "./entry.ts";
import type { ShellComponents } from "./ssr.ts";

export type { ShellAssets, ShellComponents } from "./ssr.ts";

/** The graph-side SSR runtime module's shape (`@rpxd/cli`'s ssr.ts). */
export type SsrRuntime = typeof import("./ssr.ts");

/**
 * Load the SSR runtime through the Vite server graph (dev).
 *
 * @example
 * ```ts
 * const runtime = await loadSsrRuntime(vite);
 * const html = await runtime.renderRoute(route, ctx, assets);
 * ```
 */
export async function loadSsrRuntime(vite: ViteDevServer): Promise<SsrRuntime> {
  return (await vite.ssrLoadModule(SSR_RUNTIME_URL)) as SsrRuntime;
}

function escapeHtml(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/**
 * Framework dev error page (§14): the real message plus a sourcemapped stack
 * (run the error through `vite.ssrFixStacktrace` first) — Remix/Next-style.
 * Dev only; prod goes through the app's `__error` page with a generic
 * message (see `makeShellRenderers` in `./ssr.ts`).
 *
 * @example
 * ```ts
 * if (error instanceof Error) vite.ssrFixStacktrace(error);
 * return renderDevErrorPage(ctx.path, error);
 * ```
 */
export function renderDevErrorPage(path: string, error: unknown): Response {
  const message = error instanceof Error ? error.message : String(error);
  const stack = error instanceof Error ? (error.stack ?? "") : String(error);
  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>rpxd — runtime error</title>
    <style>
      body { margin: 0; padding: 2rem; background: #1c1c22; color: #f4f4f5; font-family: ui-monospace, monospace; }
      h1 { font-size: 1rem; color: #fda4af; margin: 0 0 0.5rem; }
      .msg { font-size: 1.25rem; margin: 0 0 1.5rem; white-space: pre-wrap; }
      pre { background: #26262e; padding: 1rem; border-radius: 8px; overflow-x: auto; line-height: 1.6; }
    </style>
  </head>
  <body data-testid="rpxd-dev-error">
    <h1>Runtime error at ${escapeHtml(path)}</h1>
    <p class="msg">${escapeHtml(message)}</p>
    <pre>${escapeHtml(stack)}</pre>
  </body>
</html>`;
  return new Response(html, {
    status: 500,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

/**
 * Build the dev SSR renderer: route module AND the SSR runtime both load
 * through Vite's server graph (§12), so rendering runs in-graph.
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

    const runtime = await loadSsrRuntime(vite);
    const mod = await vite.ssrLoadModule(`/routes/${file}`);
    const route = mod.default as LiveRoute<unknown, string, unknown, FunctionComponent<object>>;
    const raw = await runtime.renderRoute(route, ctx, { entrySrc: CLIENT_ENTRY_URL }, opts);

    // Injects the HMR client and any transformIndexHtml hooks.
    const html = await vite.transformIndexHtml(ctx.path, raw);
    return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
  };
}
