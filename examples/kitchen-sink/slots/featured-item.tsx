import { live, redirect } from "@rpxd/core";
import { z } from "zod";

/**
 * A data-dependent slot (ADR 0002 item 16) that demonstrates the identity-vs-props
 * split at honest scale — ONE featured item, not a `.map()` of slots.
 *
 * - **Identity** is `$itemId` (the pattern). A change *remounts*: `setup` reruns,
 *   so `bumps` resets to 0.
 * - **Props** are `{ view, deny }` (the schema). A `view` change is a `patchProps`:
 *   `guard`+`load` rerun on the *same* instance, so `bumps` is preserved.
 * - `deny` drives the guard, the smallest honest mechanism for the guard-denied
 *   acceptance test: flip it and the slot falls back to `fallback` while the
 *   dashboard around it stays live.
 */
const schema = z.object({
  view: z.enum(["summary", "detail"]).default("summary"),
  deny: z.boolean().default(false),
});

export default live("/featured/$itemId", schema)
  .setup((ctx) => ({
    itemId: ctx.params.itemId,
    view: "summary" as "summary" | "detail",
    // Interaction state — survives a props patch, resets on an identity change.
    bumps: 0,
  }))
  .guard(async ({ props }) => {
    // Re-checked on every props change (not just mount), so toggling `deny` on a
    // live slot tears it back down to `fallback`.
    if (props.deny) throw redirect("/denied");
  })
  .load(async ({ props }, ctx) => {
    ctx.patchState((s) => {
      s.view = props.view;
    });
  })
  .rpc("bump", (r) =>
    r.handler(async (_payload, ctx) => {
      ctx.patchState((s) => {
        s.bumps += 1;
      });
    }),
  )
  .render(({ state, rpc }) => (
    <section data-testid="featured">
      <p data-testid="featured-item">item: {state.itemId}</p>
      <p data-testid="featured-view">view: {state.view}</p>
      <p data-testid="featured-bumps">bumps: {state.bumps}</p>
      <button type="button" data-testid="featured-bump" onClick={() => void rpc.bump({})}>
        bump
      </button>
    </section>
  ));
