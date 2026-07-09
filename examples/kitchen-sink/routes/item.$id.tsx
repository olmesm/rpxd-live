import { live } from "@rpxd/core";

/**
 * Tier-2 navigation demo (§7). `/item/$id` — the `$id` path param is identity.
 * Navigating `/item/1` → `/item/2` matches the *same* route pattern, so the
 * framework does a **soft reload**: it reuses the connection (the SSE transport
 * and app shell survive), mounts a fresh instance, reruns `setup`+`load`, and
 * rebinds the store — the page component is keyed by path, so its local state
 * resets. Contrast `nav.patch` (tier 1, no `setup`, state preserved) and a
 * cross-route navigation (tier 3, connection swapped).
 */
const NEIGHBOURS = ["1", "2", "3"];

export default live("/item/$id")
  // Sync skeleton — the id is identity, carried from the path param.
  .setup((ctx) => ({ id: ctx.params.id, label: "", loaded: false }))
  // The loader reruns on every path step; deterministic (no real IO) so the
  // e2e is stable while still exercising the setup+load rerun over the reused
  // connection.
  .load(async (_url, ctx) => {
    ctx.patchState((s) => {
      s.label = `Item ${ctx.params.id}`;
      s.loaded = true;
    });
  })
  .rpc("bump", (r) =>
    r
      .optimistic((state) => {
        state.label = `${state.label}!`;
      })
      .handler(async (_payload, ctx) => {
        ctx.patchState((s) => {
          s.label = `${s.label}!`;
        });
      }),
  )
  .render(({ state, rpc, nav }) => (
    <main>
      <h1>rpxd item</h1>
      <p data-testid="item-id">id: {state.id}</p>
      <p data-testid="item-label" aria-busy={!state.loaded}>
        {state.label}
      </p>
      {/* Mutates page state; a tier-2 nav to a sibling resets it (fresh setup). */}
      <button type="button" data-testid="bump" onClick={() => void rpc.bump()}>
        bump
      </button>
      <nav data-testid="siblings">
        {NEIGHBOURS.map((n) => (
          <button
            key={n}
            type="button"
            data-testid={`go-${n}`}
            onClick={() => nav.navigate("/item/$id", { params: { id: n } })}
          >
            item {n}
          </button>
        ))}
      </nav>
    </main>
  ));
