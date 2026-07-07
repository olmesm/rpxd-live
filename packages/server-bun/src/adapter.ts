/**
 * `ServerAdapter` seam (§14): web-standard `Request`/`Response` internally,
 * no Bun types past this boundary — a Node adapter later is ~100 lines.
 */

/** A running server. */
export interface ServeHandle {
  port: number;
  stop(): void | Promise<void>;
}

export interface ServeOptions {
  port?: number;
  hostname?: string;
  fetch(req: Request): Response | Promise<Response>;
}

/**
 * The runtime seam rpxd serves through. `serve` binds the HTTP listener,
 * `env` reads configuration. (WS upgrade support arrives with the `ws()`
 * transport opt-in — the envelope is transport-agnostic, §11.)
 */
export interface ServerAdapter {
  serve(opts: ServeOptions): ServeHandle;
  env(name: string): string | undefined;
}

/**
 * Bun implementation of {@link ServerAdapter} — `Bun.serve`, HTTP (+ WS
 * later) on one port (§14).
 *
 * @example
 * ```ts
 * const handle = bunAdapter().serve({ port: 3000, fetch: handler.fetch });
 * ```
 */
export function bunAdapter(): ServerAdapter {
  return {
    serve({ port = 3000, hostname, fetch }) {
      const server = Bun.serve({ port, hostname, fetch: (req) => fetch(req) });
      return {
        port: server.port ?? port,
        stop: () => server.stop(true),
      };
    },
    env: (name) => process.env[name],
  };
}
