/** Streaming rpcs (§3): each patchState tick flushes a patch envelope. */
import { expect, test } from "@playwright/test";

test("patchState flushes stream progressively, finally clears the flag", async ({ page }) => {
  await page.goto("/import");
  await page.click("button");

  // first segment: importing flag set before any items arrive
  await expect(page.getByTestId("importing")).toBeVisible();

  // items appear one segment at a time — item-1 must render while the
  // import is still running (progressive flushes, not one big patch)
  await expect(page.getByTestId("items").locator("li").first()).toContainText("item-1");
  await expect(page.getByTestId("importing")).toBeVisible();

  // completion: all three items, flag cleared by the finally block
  await expect(page.getByTestId("items").locator("li")).toHaveCount(3);
  await expect(page.getByTestId("importing")).toHaveCount(0);
  await expect(page.getByTestId("pending")).toHaveCount(0);
});
