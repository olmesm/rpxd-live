/** SSR attach + optimistic updates (§4, §12) against examples/kitchen-sink. */
import { expect, test } from "@playwright/test";
import { awaitSynced, gotoHydrated } from "./helpers";

test("SSR renders live state and hydrates cleanly", async ({ page }) => {
  const errors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(msg.text());
  });
  page.on("pageerror", (err) => errors.push(String(err)));

  // Wait for hydration (mismatches surface during `hydrateRoot`), then for the
  // connection to reach live+settled — deterministic in place of a 300ms guess.
  await gotoHydrated(page, "/");
  await expect(page.getByTestId("todos").locator("li")).toHaveCount(1);
  await expect(page.getByTestId("todos")).toContainText("Try rpxd");

  await awaitSynced(page);
  expect(errors.filter((e) => /hydrat/i.test(e))).toEqual([]);
});

test("optimistic add: instant render, server id lands without remount (keyOf)", async ({
  page,
}) => {
  // Gate the submit on hydration — a pre-hydration click falls through to a
  // native form submit and the add never happens (the shared flake class).
  await gotoHydrated(page, "/");
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
  // A pre-hydration checkbox click has no handler attached — gate on hydration.
  await gotoHydrated(page, "/");
  const checkbox = page.getByTestId("todos").locator("li").first().locator("input");
  await checkbox.click();
  await expect(checkbox).toBeChecked();

  // Wait for the toggle's ack to land (the marker restamps once no rpc is in
  // flight — the handler ran, patched, and persisted to the warm instance),
  // then reload: SSR must render from that same warm per-session instance.
  // Replaces a 1200ms guess that raced variable ack/persistence latency.
  await awaitSynced(page);
  await page.reload();
  await expect(page.getByTestId("todos").locator("li").first().locator("input")).toBeChecked();
});

test("filtering via the load loader is URL-driven (§7): nav.patch reruns the query", async ({
  page,
}) => {
  // Filter clicks are `nav.patch` handlers — gate on hydration before clicking.
  await gotoHydrated(page, "/");
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
