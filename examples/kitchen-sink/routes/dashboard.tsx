import { live } from "@rpxd/core";
import { z } from "zod";
import { DashboardBody } from "../lib/components/dashboard-body.tsx";

/**
 * The dashboard page (ADR 0002 item 16) — the RHS of the persistent shell. It
 * shows three payoffs of the "everything is live" fold:
 *
 * 1. **Typed URL props.** `?limit=20` reaches `load` as the *number* 20 because
 *    a props schema is declared (schema-less routes keep raw strings).
 * 2. **A data-dependent slot.** `<FeaturedItem>` is addressed by page-derived
 *    props — one slot, not a `.map()` (see "Aggregates, not rows").
 * 3. **A page embedded as a slot.** `<LiveSlot of={ItemBoard}>` mounts the very
 *    same live object `/item/1` a routed tab would; both share one instance.
 *
 * The interactive body is a `'use client'` island (it hosts the slots — see
 * `lib/components/dashboard-body.tsx`). This route also broadcasts a cross-object
 * notice onto the chat channel to show the server bus crossing live-object
 * boundaries (exclude-self honored).
 */
const schema = z.object({ limit: z.number().default(10) });

export default live("/dashboard", schema)
  .setup((ctx) => {
    // Share the chat channel's topic so this page can broadcast to it.
    ctx.subscribe("panel:lobby");
    return { limit: 10, limitType: "", notices: [] as string[] };
  })
  .load(async ({ props }, ctx) => {
    ctx.patchState((s) => {
      s.limit = props.limit;
      // `number` when the schema decoded it; a schema-less route would say `string`.
      s.limitType = typeof props.limit;
    });
  })
  .rpc("notify", (r) =>
    r.handler(async ({ text }: { text: string }, ctx) => {
      // Fire onto the chat channel; the chat slot's `.on("panel.notice")` renders
      // it. Exclude-self default — this page instance never receives it back.
      ctx.broadcast("panel:lobby", "panel.notice", { text });
    }),
  )
  // Proof of exclude-self: were the sender delivered its own broadcast, this
  // page's own notice would land here. It never does — this list stays empty
  // for notices this page sent.
  .on("panel.notice", (state, notice) => {
    state.notices.push(notice.text);
  })
  .render((props) => <DashboardBody {...props} />);
