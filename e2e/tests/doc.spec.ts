/** RSC fields (§16): server-rendered subtrees in state; renderer never ships. */
import { expect, test } from "@playwright/test";

// rsc fields only exist when rsc is enabled; the matrix runs a --no-rsc combo.
test.skip(process.env.RPXD_RSC === "false", "rsc disabled (--no-rsc combo)");

test("rsc field SSRs, updates live, and the heavy renderer never loads client-side", async ({
  page,
}) => {
  await page.goto("/doc");

  // server-rendered subtree present via {state.body}
  const doc = page.getByTestId("doc");
  await expect(doc.locator("h2")).toContainText("rpxd doc");
  await expect(doc.locator("em").first()).toContainText("server-only");

  // live update: rpc re-renders the field server-side; patch replaces it whole
  await page.click("text=Append");
  await expect(doc).toContainText("appended");
  await expect(doc.locator("em").nth(1)).toContainText("live");

  // §16's point: the markdown module executed only on the server
  const loadedInBrowser = await page.evaluate(
    () => (globalThis as { __MARKDOWN_LOADED?: boolean }).__MARKDOWN_LOADED,
  );
  expect(loadedInBrowser).toBeUndefined();
});
test("'use client' island inside the rsc field hydrates and stays interactive (§16)", async ({
  page,
}) => {
  await page.goto("/doc");
  const island = page.getByTestId("doc-counter");

  // island SSR'd inside the server-rendered subtree, then hydrated
  await expect(island).toContainText("likes: 7");
  await island.click();
  await expect(island).toContainText("likes: 8");

  // a live patch replaces the whole field — React reconciles the fresh
  // server subtree in place, so the island KEEPS its local state and stays
  // interactive afterwards
  await page.click("text=Append");
  await expect(page.getByTestId("doc")).toContainText("appended");
  const after = page.getByTestId("doc-counter");
  await expect(after).toContainText("likes: 8"); // state survived the patch
  await after.click();
  await expect(after).toContainText("likes: 9");

  // the island's module shipped (it must), but the markdown renderer didn't
  const loadedInBrowser = await page.evaluate(
    () => (globalThis as { __MARKDOWN_LOADED?: boolean }).__MARKDOWN_LOADED,
  );
  expect(loadedInBrowser).toBeUndefined();
});
