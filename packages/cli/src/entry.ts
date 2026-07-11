/**
 * Framework-owned client entry (§14 zero-config): hydrates the SSR'd page,
 * opens the live connection with the attach token, and feeds render props
 * into the route component. Served as a Vite virtual module — userland never
 * writes an entry file.
 */
import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";

/** Public URL of the client entry, referenced by the SSR HTML shell. */
export const CLIENT_ENTRY_URL = "/@rpxd-entry.tsx";

const VIRTUAL_ID = "\0rpxd-entry.tsx";

/**
 * Virtual id of the graph-side SSR runtime (§12): a re-export of the
 * framework's `ssr.ts` by absolute path, so it loads INSIDE the server
 * module graph (dev `ssrLoadModule`, prod server bundle) without requiring
 * apps to depend on `@rpxd/cli` for module resolution.
 */
export const SSR_RUNTIME_URL = "/@rpxd-ssr.ts";

const SSR_RUNTIME_VIRTUAL_ID = "\0rpxd-ssr.ts";
const SSR_RUNTIME_FILE = fileURLToPath(new URL("./ssr.ts", import.meta.url));

const clientEntrySource = (rsc: boolean, transport: "sse" | "ws") => `
import { createElement } from "react";
import { hydrateRoot } from "react-dom/client";
import { LiveApp, LiveConnection, rpcMetaFromDef } from "@rpxd/client";
import { routeModules, rootModule } from "/.rpxd/routes.gen.ts";
${
  rsc
    ? `import { configureRscRuntime, flightStream, hydrateRscFields } from "@rpxd/rsc/client";
import { createFromReadableStream } from "@vitejs/plugin-rsc/browser";
configureRscRuntime((payload) => createFromReadableStream(flightStream(payload)));`
    : ""
}

const bootEl = document.getElementById("__rpxd");
const rootEl = document.getElementById("root");
if (!bootEl || !rootEl) throw new Error("rpxd bootstrap payload missing");
const boot = JSON.parse(bootEl.textContent);

const load = routeModules[boot.path];
if (!load) throw new Error("no route module for " + boot.path);
const route = (await load()).default;

const conn = new LiveConnection({
  instance: boot.instance,
  bootstrap: boot,
  meta: rpcMetaFromDef(route.def),${transport === "ws" ? '\n  transport: "ws",' : ""}
});
conn.connect();

const app = createElement(LiveApp, {
  route,
  connection: conn,
  routeModules,${transport === "ws" ? '\n  transport: "ws",' : ""}${rsc ? "\n  transformState: hydrateRscFields," : ""}
});

const Root = rootModule ? (await rootModule()).default : null;
hydrateRoot(rootEl, Root ? createElement(Root, null, app) : app);
// Hydration marker: a click that lands before hydration is lost (no handler
// attached yet) or falls through to a native form submit. Stamped after
// hydrateRoot commits the shell so tests/apps can gate interaction on it.
document.documentElement.dataset.rpxdHydrated = "true";
`;

/**
 * Vite plugin serving the client entry as a virtual module. `transport`
 * bakes the configured transport into the connection (§11 dev/prod parity).
 *
 * @example
 * ```ts
 * createServer({ plugins: [rpxdEntryPlugin({ rsc: true, transport: "ws" })] });
 * ```
 */
export function rpxdEntryPlugin(opts: { rsc?: boolean; transport?: "sse" | "ws" } = {}): Plugin {
  return {
    name: "rpxd-client-entry",
    resolveId(id) {
      if (id === CLIENT_ENTRY_URL) return VIRTUAL_ID;
      if (id === SSR_RUNTIME_URL) return SSR_RUNTIME_VIRTUAL_ID;
      return undefined;
    },
    load(id) {
      if (id === VIRTUAL_ID) return clientEntrySource(opts.rsc ?? false, opts.transport ?? "sse");
      if (id === SSR_RUNTIME_VIRTUAL_ID) {
        return `export * from ${JSON.stringify(SSR_RUNTIME_FILE)};`;
      }
      return undefined;
    },
  };
}
