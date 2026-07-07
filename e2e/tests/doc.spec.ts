/** RSC fields (§16): server-rendered subtrees in state; renderer never ships. */
import { expect, test } from "@playwright/test";

test("rsc field SSRs, updates live, and the heavy renderer never loads client-side", async ({
  page,
}) => {
  await page.goto("/doc");

  // server-rendered subtree present via {state.body}
  const doc = page.getByTestId("doc");
  await expect(doc.locator("h2")).toContainText("rpxd doc");
  await expect(doc.locator("em").first()).toContainText("server-only");

  // live update: rpc re-renders the field server-side; patch replaces it whole
  await page.click("button");
  await expect(doc).toContainText("appended");
  await expect(doc.locator("em").nth(1)).toContainText("live");

  // §16's point: the markdown module executed only on the server
  const loadedInBrowser = await page.evaluate(
    () => (globalThis as { __MARKDOWN_LOADED?: boolean }).__MARKDOWN_LOADED,
  );
  expect(loadedInBrowser).toBeUndefined();
});
