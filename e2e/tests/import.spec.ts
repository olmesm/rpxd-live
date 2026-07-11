/** Streaming rpcs (§3): each patchState tick flushes a patch envelope. */
import { expect, test } from "@playwright/test";
import { gotoHydrated } from "./helpers";

test("patchState flushes stream progressively, then clears the flag", async ({ page }) => {
  // Hydration gate: a pre-hydration click on the (type="button") preset does
  // nothing — no handler attached yet — and the import never starts.
  await gotoHydrated(page, "/import");
  await page.getByTestId("import-sample").click();

  // first segment: importing flag set before any items arrive
  await expect(page.getByTestId("importing")).toBeVisible();

  // items appear one segment at a time — item-1 must render while the
  // import is still running (progressive flushes, not one big patch)
  await expect(page.getByTestId("items").locator("li").first()).toContainText("item-1");
  await expect(page.getByTestId("importing")).toBeVisible();

  // completion: all three items, flag cleared by the handler's final patch
  await expect(page.getByTestId("items").locator("li")).toHaveCount(3);
  await expect(page.getByTestId("importing")).toHaveCount(0);
  await expect(page.getByTestId("pending")).toHaveCount(0);
});

test("a poison row rejects the rpc and .onError repairs state on the error ack", async ({
  page,
}) => {
  await gotoHydrated(page, "/import");
  await page.getByTestId("import-bad").click();

  // the two good rows before the poison row land first
  await expect(page.getByTestId("items").locator("li")).toHaveCount(2);

  // the throw's repair: importing cleared, the error surfaced with the count
  await expect(page.getByTestId("error")).toContainText("import failed after 2 rows");
  await expect(page.getByTestId("importing")).toHaveCount(0);
});
