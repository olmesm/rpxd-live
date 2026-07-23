/**
 * Tier-2 soft reload (§7, ADR 0002): a same-route path change (`/item/1` →
 * `/item/2`, both matching `/item/$id`) reuses the connection — the SSE
 * transport and app shell survive — while the target identity mounts. A
 * never-seen identity loads fresh (clean state); a **warm** identity (return
 * navigation within the session's warm TTL) is reused with its instance state
 * intact — `guard` reruns, `load` is skipped for identical props (warm-mount
 * dedup, ADR 0002 item 8). Instance state lives with the session, not the DOM.
 * We prove the shell survives (no full page load) with a `window` marker that
 * a real navigation would wipe.
 */
import { expect, test } from "@playwright/test";

test("same-route path change soft-reloads: shell survives, fresh identity clean, warm identity preserved (§7 tier 2)", async ({
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

  // The URL changed and a never-seen identity loaded fresh — clean state.
  await expect(page).toHaveURL(/\/item\/2$/);
  await expect(page.getByTestId("item-id")).toHaveText("id: 2");
  await expect(page.getByTestId("item-label")).toHaveText("Item 2"); // NOT "Item 2!" — fresh identity

  // The app shell (and its SSE transport) survived the path change.
  const shell = await page.evaluate(() => (window as unknown as { __shell?: number }).__shell);
  expect(shell).toBe(42);

  // Back to item 1: the instance is still warm in this session, so it is
  // reused with state intact — the earlier bump SURVIVES the round trip
  // (guard reran; load was skipped for identical props — ADR 0002 item 8).
  await page.getByTestId("go-1").click();
  await expect(page.getByTestId("item-id")).toHaveText("id: 1");
  await expect(page.getByTestId("item-label")).toHaveText("Item 1!");
});
