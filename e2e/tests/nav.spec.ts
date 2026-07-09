/** SPA navigation (§7): Link/nav.navigate swap routes without a page load. */
import { expect, test } from "@playwright/test";

test("Link navigation is soft — no reload, and the next page is live", async ({ page }) => {
  await page.goto("/", { waitUntil: "load" });
  // A full page load would wipe this marker.
  await page.evaluate(() => {
    (window as unknown as { __rpxdMarker?: string }).__rpxdMarker = "alive";
  });

  await page.click("nav >> text=chat");
  await expect(page.getByTestId("messages")).toBeAttached();
  expect(
    await page.evaluate(() => (window as unknown as { __rpxdMarker?: string }).__rpxdMarker),
  ).toBe("alive");

  // The swapped-in page is fully live: rpc round-trip over its own connection.
  await page.fill('input[name="text"]', "soft nav works");
  await page.press('input[name="text"]', "Enter");
  await expect(page.getByTestId("messages")).toContainText("soft nav works");
});

test("navigating back and forth keeps each page working", async ({ page }) => {
  await page.goto("/", { waitUntil: "load" });
  await page.evaluate(() => {
    (window as unknown as { __rpxdMarker?: string }).__rpxdMarker = "alive";
  });

  await page.click("nav >> text=import");
  await expect(page.getByTestId("items")).toBeAttached();

  await page.click("nav >> text=todos");
  await expect(page.getByTestId("todos")).toBeAttached();
  // The todos page is live again after the round trip (fresh setup + load).
  await page.fill('input[name="text"]', "back again");
  await page.click("text=Add");
  await expect(page.getByTestId("todos")).toContainText("back again");

  expect(
    await page.evaluate(() => (window as unknown as { __rpxdMarker?: string }).__rpxdMarker),
  ).toBe("alive");
});
