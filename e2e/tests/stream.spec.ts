/** Streaming (§3): a handler grows state token-by-token via `append` patches. */
import { expect, test } from "@playwright/test";

test("a streamed answer updates incrementally, token by token", async ({ page }) => {
  await page.goto("/stream");
  const answer = page.getByTestId("answer");
  await expect(answer).toBeEmpty();

  await page.getByTestId("generate").click();

  // the stream is in flight...
  await expect(page.getByTestId("streaming")).toBeVisible();

  // ...and it updates *before* it finishes — an early token is on screen
  await expect(answer).toContainText("the");
  const mid = (await answer.textContent()) ?? "";

  // a later token lands, and the text has genuinely grown (the "update")
  await expect(answer).toContainText("fox");
  const later = (await answer.textContent()) ?? "";
  expect(later.length).toBeGreaterThan(mid.length);

  // completes: the full sentence, streaming indicator gone
  await expect(answer).toContainText("lazy dog");
  await expect(page.getByTestId("streaming")).toBeHidden();
});

test("stop aborts the stream mid-flight (ctx.abort + ctx.signal)", async ({ page }) => {
  await page.goto("/stream");
  await page.getByTestId("generate").click();
  await expect(page.getByTestId("answer")).toContainText("the");

  await page.getByTestId("stop").click();
  await expect(page.getByTestId("streaming")).toBeHidden();

  // aborted before the final token — the stream stopped growing
  const stopped = (await page.getByTestId("answer").textContent()) ?? "";
  expect(stopped).not.toContain("lazy dog");
});
