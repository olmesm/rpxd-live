/**
 * Graph-side SSR runtime (§12): render props construction, the streaming
 * page renderer, and the static shell pages. This module runs INSIDE the
 * server module graph — the Vite `ssr` environment in dev, bundled into
 * `dist/server/entry-server.js` for prod — so `rpxd dev`/`rpxd start` stay
 * pure transport and RSC-field deserialization (§16) can reach the plugin's
 * environment-scoped modules.
 *
 * Rendering always streams (`react-dom/server.edge`): identical output for
 * non-suspending trees, and resolving Flight client references (§16)
 * suspends — which `renderToString` cannot do.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import type { LiveRoute, SyncState } from "@rpxd/core";
import {
  configureRscRuntime,
  flightStream,
  hydrateRscFields,
  type RscField,
} from "@rpxd/rsc/client";
import { makeDiagnosticEmit, type RenderContext } from "@rpxd/server-bun";
import { createElement, type FunctionComponent, type ReactElement, type ReactNode } from "react";
import { renderToReadableStream } from "react-dom/server.edge";

// Standalone SSR diagnostics (#73): the shell renderers run without an app hook,
// so route a prod render crash through the default (console) sink under the
// unified `request` taxonomy.
const emit = makeDiagnosticEmit();

/**
 * Build the SSR-side RSC-field verifier (§16, #95): an HMAC-SHA256 check over
 * the payload, matching `signRscField` in `packages/rsc/src/server.ts` byte
 * for byte — same algorithm (hex digest), same env var
 * (`RPXD_SESSION_SECRET`). `rsc()` runs in the react-server graph and this
 * verifier runs in the ssr graph — separate module graphs in the same
 * process — so that env var is the only channel carrying the shared secret
 * between them. `node:crypto` stays inline here (not in `@rpxd/rsc`'s
 * `client.ts`/`shared.ts`, which are browser-imported and must stay
 * crypto-free); `timingSafeEqual` compares the MAC bytes so a forged tag
 * can't be brute-forced via response-time differences.
 *
 * Returns `undefined` when no secret is configured, so
 * `configureRscRuntime` gets no verifier and deserializes unverified
 * (back-compat: an explicit `cookie.sign:false` opts out of the whole B2/#95
 * secret machinery; with #122 dev always has a secret otherwise, so this only
 * happens in that opt-out).
 *
 * @example
 * ```ts
 * const verify = makeRscVerifier();
 * verify?.({ $rsc: "<p/>", $rscTag: "…" }); // true only if the HMAC checks out
 * ```
 */
export function makeRscVerifier(): ((field: RscField) => boolean) | undefined {
  const secret = process.env.RPXD_SESSION_SECRET;
  if (!secret) return undefined;
  return (field: RscField): boolean => {
    if (!field.$rscTag) return false; // a secret exists — an untagged field is unverifiable, not trusted
    // Matching algorithm: HMAC-SHA256 hex digest — must mirror server.ts's signRscField.
    const want = createHmac("sha256", secret).update(field.$rsc).digest("hex");
    const got = Buffer.from(field.$rscTag);
    const wantBuf = Buffer.from(want);
    return got.length === wantBuf.length && timingSafeEqual(got, wantBuf);
  };
}

let flightRuntimeReady: Promise<void> | undefined;

/** Install the server-graph Flight deserializer once (§16), verified (#95) when a secret is configured. */
function ensureFlightRuntime(): Promise<void> {
  flightRuntimeReady ??= import("@vitejs/plugin-rsc/ssr").then(({ createFromReadableStream }) => {
    configureRscRuntime(
      (payload) => createFromReadableStream(flightStream(payload)),
      makeRscVerifier(),
    );
  });
  return flightRuntimeReady;
}

/** Server-side render props: same shape the client hydrates with (§1). */
function serverRenderProps(ctx: RenderContext, rsc: boolean) {
  return {
    state: rsc ? hydrateRscFields(ctx.state) : ctx.state,
    session: ctx.session ?? {},
    // `satisfies` pins this to the real SyncState — the render call erases
    // prop types (FunctionComponent<object>), so drift wouldn't fail tsc.
    sync: { pending: false, inFlight: 0, errors: [], clearErrors: () => {} } satisfies SyncState,
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
  /**
   * The persistent region (ADR 0002 item 13): `__layout.tsx`. On the client it
   * renders inside `RpxdProvider` but outside the page key; server-side it
   * composes **between** {@link Root} and the page (`Root(Layout(page))`) so the
   * hydrated tree matches. Live pages only — never the static 404/error shells,
   * which the client renders without the layout. Any `<LiveSlot>` it hosts SSRs
   * as its `fallback` (a slot has no server connection; it client-mounts
   * post-hydration).
   */
  Layout?: FunctionComponent<{ children?: ReactNode }>;
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
 * Compose the persistent region (ADR 0002 item 13) around a live page:
 * `Root(Layout(page))`. Mirrors the client's `Root > RpxdProvider > Layout >
 * page` tree (the provider adds no DOM), so hydration matches. The static 404/
 * error shells don't call this — the client never wraps them in the layout.
 */
function wrapWithLayout(page: ReactElement, shell?: ShellComponents): ReactElement {
  const withLayout = shell?.Layout ? createElement(shell.Layout, null, page) : page;
  return wrapWithRoot(withLayout, shell);
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
  const appHtml = await streamToHtml(wrapWithLayout(page, opts.shell));
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
            emit({
              category: "request",
              type: "ssr-render-error",
              level: "error",
              error: info.error,
              detail: { path: info.path, ref },
            });
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
