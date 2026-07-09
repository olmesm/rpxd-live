import { live } from "@rpxd/core";

/**
 * Streaming rpc demo (§3): streaming is just a loop — each `patchState` tick
 * flushes a patch envelope, so the client watches items appear while the
 * import runs. The `finally` flush rides the ack.
 */
export default live("/import")
  .setup(() => ({ items: [] as string[], importing: false }))
  .rpc("importDemo", (r) =>
    r.handler(async (_payload, ctx) => {
      ctx.patchState((s) => {
        s.importing = true;
      });
      try {
        for (let i = 1; i <= 3; i++) {
          await new Promise((resolve) => setTimeout(resolve, 150));
          ctx.patchState((s) => {
            s.items.push(`item-${i}`);
          });
        }
      } finally {
        ctx.patchState((s) => {
          s.importing = false;
        });
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
