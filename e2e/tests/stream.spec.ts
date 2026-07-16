/** Streaming (§3): a handler grows state token-by-token via `append` patches. */
import { expect, test } from "@playwright/test";
import { gotoHydrated } from "./helpers";

test("a streamed answer updates incrementally, token by token", async ({ page }) => {
  // Gate on hydration: a pre-hydration `generate` click is lost (no onClick
  // attached yet), the rpc never fires, and `streaming` never appears — the
  // shared slow-boot flake class (see helpers.ts), sharper on the ws combo.
  await gotoHydrated(page, "/stream");
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
  // Same hydration gate — the generate/stop clicks must land on wired handlers.
  await gotoHydrated(page, "/stream");
  await page.getByTestId("generate").click();
  await expect(page.getByTestId("answer")).toContainText("the");

  await page.getByTestId("stop").click();
  await expect(page.getByTestId("streaming")).toBeHidden();

  // aborted before the final token — the stream stopped growing
  const stopped = (await page.getByTestId("answer").textContent()) ?? "";
  expect(stopped).not.toContain("lazy dog");
});
