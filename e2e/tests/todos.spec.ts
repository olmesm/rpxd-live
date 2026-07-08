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
  // render from the same warm per-session instance (generous settle: the
  // real DB write is slower than the old in-memory store under parallel load)
  await page.waitForTimeout(1200);
  await page.reload();
  await expect(page.getByTestId("todos").locator("li").first().locator("input")).toBeChecked();
});

test("filtering via the params loader is URL-driven (§7): nav.patch reruns the query", async ({
  page,
}) => {
  await page.goto("/");
  const list = page.getByTestId("todos");
  await expect(list.locator("li")).toHaveCount(1); // seeded "Try rpxd" (not done)

  // Filter to "done": nav.patch updates the URL, the loader re-queries, the
  // not-done seed row drops out — no full remount.
  await page.getByTestId("filter-done").click();
  await expect(page).toHaveURL(/[?&]filter=done/);
  await expect(list.locator("li")).toHaveCount(0);

  // Back to "all": the loader reruns from the URL, the row returns.
  await page.getByTestId("filter-all").click();
  await expect(list.locator("li")).toHaveCount(1);

  // A shared/bookmarked filtered URL rebuilds the same window on a cold load.
  await page.goto("/?filter=done");
  await expect(page.getByTestId("filter-done")).toHaveAttribute("aria-current", "true");
  await expect(page.getByTestId("todos").locator("li")).toHaveCount(0);
});
