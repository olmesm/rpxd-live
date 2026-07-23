/**
 * Dashboard slot semantics (ADR 0002 item 16) — per-session, no shared bus, so
 * these run in parallel with the rest of the suite: identity-vs-props on the
 * featured slot, guard-denied fallback, and typed URL props.
 */
import { expect, test } from "@playwright/test";
import { gotoHydrated } from "./helpers";

test("featured slot: a props change patches (state kept), identity change remounts (reset)", async ({
  page,
}) => {
  await gotoHydrated(page, "/dashboard");
  await expect(page.getByTestId("featured-item")).toHaveText("item: 1");
  await expect(page.getByTestId("featured-view")).toHaveText("view: summary");

  // Build up interaction state on the current instance.
  await page.getByTestId("featured-bump").click();
  await page.getByTestId("featured-bump").click();
  await expect(page.getByTestId("featured-bumps")).toHaveText("bumps: 2");

  // Props change (view) → patchProps: guard+load rerun on the SAME instance, so
  // the view updates but the bump count is preserved.
  await page.getByTestId("view-toggle").click();
  await expect(page.getByTestId("featured-view")).toHaveText("view: detail");
  await expect(page.getByTestId("featured-bumps")).toHaveText("bumps: 2");

  // Identity change (itemId) → remount: setup reruns, so bumps reset to 0.
  await page.getByTestId("feature-2").click();
  await expect(page.getByTestId("featured-item")).toHaveText("item: 2");
  await expect(page.getByTestId("featured-bumps")).toHaveText("bumps: 0");
});

test("guard-denied slot renders its fallback while the dashboard stays live", async ({ page }) => {
  await gotoHydrated(page, "/dashboard");
  await expect(page.getByTestId("featured")).toBeVisible();

  // Flip the deny prop → the slot's guard redirects on the next patch → the slot
  // tears down to its fallback.
  await page.getByTestId("deny-toggle").click();
  await expect(page.getByTestId("featured-fallback")).toBeVisible();
  await expect(page.getByTestId("featured")).toHaveCount(0);

  // The rest of the dashboard — and the persistent chat panel — stay live.
  await expect(page.getByTestId("chat-panel")).toBeVisible();
  await expect(page.getByTestId("board-embed").getByTestId("item-label")).toHaveText("Item 1");
});

test("typed URL props: ?limit=20 reads as the number 20 (not a string)", async ({ page }) => {
  await gotoHydrated(page, "/dashboard?limit=20");
  // The props schema makes the codec decode `20` as a number; a schema-less
  // route would render `(string)`.
  await expect(page.getByTestId("limit")).toHaveText("limit: 20 (number)");
});

test("tier-2/3 nav to a schema'd page with ?limit=20 stays SOFT (no full reload) + applies the number (R2 residual A)", async ({
  page,
}) => {
  // Start OFF the dashboard so reaching /dashboard?limit=20 is a path-changing
  // (tier-2/3) navigation, not a same-path tier-1 search change.
  await gotoHydrated(page, "/item/1");

  // Stamp the live document — a full page reload would wipe this; a soft nav
  // (app-lifetime connection reused) keeps it.
  await page.evaluate(() => {
    (window as unknown as { __shell?: number }).__shell = 99;
  });

  // The persistent shell's link to /dashboard?limit=20 (tier 3). Before the fix
  // the raw string "20" rode the wire, the server's z.number() props schema
  // 422'd it, `#mountRequest` threw, and `performNavigation` fell back to a FULL
  // PAGE RELOAD on every such nav — permanently. Now the URL props are decoded
  // client-side before the wire, so the number reaches `load` over a soft nav.
  await page.getByRole("link", { name: "dash20" }).click();

  await expect(page).toHaveURL(/\/dashboard\?limit=20\b/);
  // The decoded number reached `load` — a number, not a string.
  await expect(page.getByTestId("limit")).toHaveText("limit: 20 (number)");
  // The shell survived: this was a soft nav, NOT a full reload.
  const shell = await page.evaluate(() => (window as unknown as { __shell?: number }).__shell);
  expect(shell).toBe(99);
});

test("tier-1 nav on a schema'd page applies the typed value (review R1 finding 3)", async ({
  page,
}) => {
  await gotoHydrated(page, "/dashboard");
  // Default from the schema (no query): 10, still a number.
  await expect(page.getByTestId("limit")).toHaveText("limit: 10 (number)");

  // A tier-1 `nav.patch({ limit: 20 })` — no full page load. Before the fix the
  // URL-derived/wire props were raw strings, so the server's `z.number()` props
  // schema rejected `"20"` with a 422 that vanished silently (URL moved, state
  // didn't). Now the DECODED number rides the wire and `load` reruns with 20.
  await page.getByTestId("set-limit-20").click();
  await expect(page.getByTestId("limit")).toHaveText("limit: 20 (number)");
  // The soft-nav wrote the URL bar too (round-trip coherence).
  await expect(page).toHaveURL(/[?&]limit=20\b/);
});
