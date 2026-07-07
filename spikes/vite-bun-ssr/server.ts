/**
 * Vite-on-Bun SSR smoke server (spec §14 early smoke test).
 *
 * Architecture under test: ONE Bun process running Vite in middleware mode
 * (dev transforms + HMR) plus our own request handling (SSR render), all on
 * one port. This is the least-trodden path for the `rpxd dev` server; this
 * spike exists to prove it before the CLI commits to it.
 */
import { readFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { createServer as createViteServer, type ViteDevServer } from "vite";

const root = fileURLToPath(new URL(".", import.meta.url));

export interface SmokeServer {
  port: number;
  vite: ViteDevServer;
  close(): Promise<void>;
}

/** Boot Vite (middleware mode) inside Bun and serve SSR'd HTML on an ephemeral port. */
export async function startSmokeServer(): Promise<SmokeServer> {
  const httpServer = createHttpServer();

  const vite = await createViteServer({
    root,
    appType: "custom",
    logLevel: "error",
    server: {
      middlewareMode: true,
      // Share the HMR websocket with our HTTP server: one process, one port.
      hmr: { server: httpServer },
    },
  });

  const template = readFileSync(new URL("./index.html", import.meta.url), "utf-8");

  httpServer.on("request", (req, res) => {
    vite.middlewares(req, res, async () => {
      try {
        const url = req.url ?? "/";
        const { render } = (await vite.ssrLoadModule("/src/entry-server.tsx")) as {
          render(now: string): string;
        };
        const appHtml = render("smoke-run");
        const html = (await vite.transformIndexHtml(url, template)).replace(
          "<!--ssr-outlet-->",
          appHtml,
        );
        res.setHeader("content-type", "text/html");
        res.end(html);
      } catch (e) {
        vite.ssrFixStacktrace(e as Error);
        res.statusCode = 500;
        res.end(String(e));
      }
    });
  });

  await new Promise<void>((resolve) => httpServer.listen(0, resolve));
  const { port } = httpServer.address() as AddressInfo;

  return {
    port,
    vite,
    async close() {
      await vite.close();
      await new Promise<void>((resolve, reject) =>
        httpServer.close((err) => (err ? reject(err) : resolve())),
      );
    },
  };
}
