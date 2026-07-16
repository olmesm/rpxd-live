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
