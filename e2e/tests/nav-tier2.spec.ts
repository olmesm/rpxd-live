/**
 * Tier-2 soft reload (§7): a same-route path change (`/item/1` → `/item/2`,
 * both matching `/item/$id`) reuses the connection — the SSE transport and app
 * shell survive — while `setup`+`load` rerun and page state resets. We prove
 * the shell survives (no full page load) with a `window` marker that a real
 * navigation would wipe, and prove state resets by bumping one item's label and
 * seeing a sibling start clean.
 */
import { expect, test } from "@playwright/test";

test("same-route path change soft-reloads: shell survives, state resets (§7 tier 2)", async ({
  page,
}) => {
  await page.goto("/item/1");
  await expect(page.getByTestId("item-id")).toHaveText("id: 1");
  await expect(page.getByTestId("item-label")).toHaveText("Item 1"); // load ran

  // Stamp the live document — a full page load would clear this; a soft reload
  // (tier 2, shell reused) keeps it.
  await page.evaluate(() => {
    (window as unknown as { __shell?: number }).__shell = 42;
  });

  // Mutate this instance's page state, then navigate to a sibling.
  await page.getByTestId("bump").click();
  await expect(page.getByTestId("item-label")).toHaveText("Item 1!");

  await page.getByTestId("go-2").click();

  // The URL changed and the fresh instance loaded — new identity, clean state.
  await expect(page).toHaveURL(/\/item\/2$/);
  await expect(page.getByTestId("item-id")).toHaveText("id: 2");
  await expect(page.getByTestId("item-label")).toHaveText("Item 2"); // NOT "Item 2!" — state reset

  // The app shell (and its SSE transport) survived the path change.
  const shell = await page.evaluate(() => (window as unknown as { __shell?: number }).__shell);
  expect(shell).toBe(42);

  // Back to item 1: also a fresh instance — the earlier bump did not persist.
  await page.getByTestId("go-1").click();
  await expect(page.getByTestId("item-id")).toHaveText("id: 1");
  await expect(page.getByTestId("item-label")).toHaveText("Item 1");
});
