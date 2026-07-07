import type { RenderProps } from "@rpxd/client";
import { live } from "@rpxd/core";
import type { Draft } from "immer";

interface ImportState {
  items: string[];
  importing: boolean;
}
type Get = () => Draft<ImportState>;

/**
 * Generator rpc demo (§3): each `yield` flushes a patch segment, so the
 * client watches items stream in while the import runs.
 */
export default live("/import")({
  mount: async () => ({ items: [] as string[], importing: false }),
  rpc: {
    importDemo: {
      async *handler(getState: Get) {
        try {
          getState().importing = true;
          yield;
          for (let i = 1; i <= 3; i++) {
            await new Promise((r) => setTimeout(r, 150));
            getState().items.push(`item-${i}`);
            yield;
          }
        } finally {
          getState().importing = false;
        }
      },
    },
  },
})(({ state, rpc, sync }: RenderProps<ImportState>) => (
  <main>
    <h1>rpxd import</h1>
    <button type="button" onClick={() => void rpc.importDemo?.({})} disabled={state.importing}>
      Start import
    </button>
    {state.importing && <span data-testid="importing">importing…</span>}
    {sync.pending && <span data-testid="pending">syncing…</span>}
    <ul data-testid="items">
      {state.items.map((item) => (
        <li key={item}>{item}</li>
      ))}
    </ul>
  </main>
));
