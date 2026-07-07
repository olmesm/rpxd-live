import { live } from "@rpxd/core";

/**
 * Generator rpc demo (§3): each `yield` flushes a patch segment, so the
 * client watches items stream in while the import runs.
 */
export default live("/import")
  .mount(async () => ({ items: [] as string[], importing: false }))
  .rpc("importDemo", (r) =>
    r.stream(async function* (getState) {
      try {
        getState().importing = true;
        yield;
        for (let i = 1; i <= 3; i++) {
          await new Promise((resolve) => setTimeout(resolve, 150));
          getState().items.push(`item-${i}`);
          yield;
        }
      } finally {
        getState().importing = false;
      }
    }),
  )
  .render(({ state, rpc, sync }) => (
    <main>
      <h1>rpxd import</h1>
      <button type="button" onClick={() => void rpc.importDemo()} disabled={state.importing}>
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
