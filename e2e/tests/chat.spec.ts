/** Multiplayer via pubsub (§8): two sessions, broadcast fan-out. */
import { type BrowserContext, expect, test } from "@playwright/test";

test("two sessions see each other's messages (single-code-path, self:true)", async ({
  browser,
}) => {
  const contexts: BrowserContext[] = [await browser.newContext(), await browser.newContext()];
  const pages = await Promise.all(contexts.map((c) => c.newPage()));
  const alice = pages[0] as (typeof pages)[number];
  const bob = pages[1] as (typeof pages)[number];

  await alice.goto("/chat");
  await bob.goto("/chat");

  await alice.fill('input[name="text"]', "hello from alice");
  await alice.click('button[type="submit"]');

  // sender sees it via { self: true } — all mutation lives in the on-handler
  await expect(alice.getByTestId("messages")).toContainText("hello from alice");
  // the other session sees it via the bus (§8)
  await expect(bob.getByTestId("messages")).toContainText("hello from alice");

  await bob.fill('input[name="text"]', "hi alice");
  await bob.click('button[type="submit"]');
  await expect(alice.getByTestId("messages")).toContainText("hi alice");

  await Promise.all(contexts.map((c) => c.close()));
});
