/**
 * Framework-owned client entry (§14 zero-config): hydrates the SSR'd page,
 * opens the live connection with the attach token, and feeds render props
 * into the route component. Served as a Vite virtual module — userland never
 * writes an entry file.
 */
import type { Plugin } from "vite";

/** Public URL of the client entry, referenced by the SSR HTML shell. */
export const CLIENT_ENTRY_URL = "/@rpxd-entry.tsx";

const VIRTUAL_ID = "\0rpxd-entry.tsx";

const clientEntrySource = (rsc: boolean) => `
import { createElement } from "react";
import { hydrateRoot } from "react-dom/client";
import { LiveConnection, rpcMetaFromDef } from "@rpxd/client";
import { useLiveStore } from "@rpxd/client/react";
import { routeModules, rootModule } from "/.rpxd/routes.gen.ts";
${rsc ? 'import { hydrateRscFields } from "@rpxd/rsc/client";' : ""}

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
  meta: rpcMetaFromDef(route.def),
});
conn.connect();

function App() {
  const snap = useLiveStore(conn.store);
  return createElement(route.component, {
    state: ${rsc ? "hydrateRscFields(snap.state)" : "snap.state"},
    session: snap.session ?? {},
    sync: snap.sync,
    status: snap.status,
    keyOf: snap.keyOf,
    rpc: conn.store.rpc,
    nav: {
      navigate: (to) => { window.location.href = to; },
      patch: (search) => conn.patchParams(search),
    },
  });
}

const Root = rootModule ? (await rootModule()).default : null;
hydrateRoot(rootEl, Root ? createElement(Root, null, createElement(App)) : createElement(App));
`;

/** Vite plugin serving the client entry as a virtual module. */
export function rpxdEntryPlugin(opts: { rsc?: boolean } = {}): Plugin {
  return {
    name: "rpxd-client-entry",
    resolveId(id) {
      if (id === CLIENT_ENTRY_URL) return VIRTUAL_ID;
      return undefined;
    },
    load(id) {
      if (id === VIRTUAL_ID) return clientEntrySource(opts.rsc ?? false);
      return undefined;
    },
  };
}
