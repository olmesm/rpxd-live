/** SSR attach + optimistic updates (§4, §12) against examples/todos. */
import { expect, test } from "@playwright/test";

test("SSR renders live state and hydrates cleanly", async ({ page }) => {
  const errors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(msg.text());
  });
  page.on("pageerror", (err) => errors.push(String(err)));

  await page.goto("/");
  await expect(page.getByTestId("todos").locator("li")).toHaveCount(1);
  await expect(page.getByTestId("todos")).toContainText("Try rpxd");

  // give hydration a beat, then assert no hydration mismatches surfaced
  await page.waitForTimeout(300);
  expect(errors.filter((e) => /hydrat/i.test(e))).toEqual([]);
});

test("optimistic add: instant render, server id lands without remount (keyOf)", async ({
  page,
}) => {
  await page.goto("/");
  await page.fill('input[name="text"]', "optimistic todo");
  await page.click('button[type="submit"]');

  // appears immediately (optimistic replay)
  const second = page.getByTestId("todos").locator("li").nth(1);
  await expect(second).toContainText("optimistic todo");

  // mark the DOM node, then wait for the server id to land
  await second.evaluate((el) => {
    (el as HTMLElement & { __marker?: boolean }).__marker = true;
  });
  await expect(second).toHaveAttribute("data-id", /^srv-/);

  // same element instance → keyOf kept the key stable, no remount (§4)
  const stillMarked = await second.evaluate(
    (el) => (el as HTMLElement & { __marker?: boolean }).__marker === true,
  );
  expect(stillMarked).toBe(true);
});

test("optimistic toggle survives a reload via the warm instance (§11)", async ({ page }) => {
  await page.goto("/");
  const checkbox = page.getByTestId("todos").locator("li").first().locator("input");
  await checkbox.click();
  await expect(checkbox).toBeChecked();

  // wait for the ack to reach confirmed state, then reload — SSR must
  // render from the same warm per-session instance
  await page.waitForTimeout(400);
  await page.reload();
  await expect(page.getByTestId("todos").locator("li").first().locator("input")).toBeChecked();
});
