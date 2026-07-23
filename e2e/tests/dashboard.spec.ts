/**
 * Dashboard acceptance (ADR 0002 item 16) — the "everything is live" gate.
 *
 * Every test here touches the persistent chat panel on the shared `panel:lobby`
 * channel (multiplayer, cross-object bus), so they run **serially** to keep the
 * bus deterministic; the isolated per-session slot tests live in
 * `dashboard-slots.spec.ts` (parallel-safe).
 */
import { type BrowserContext, expect, type Page, test } from "@playwright/test";
import { gotoHydrated } from "./helpers";

test.describe.configure({ mode: "serial" });

/** Send a chat message through the persistent panel and wait for it to land. */
async function sendChat(page: Page, text: string): Promise<void> {
  await page.getByTestId("chat-draft").fill(text);
  await page.getByTestId("chat-form").getByRole("button", { name: "Send" }).click();
  await expect(page.getByTestId("chat-messages")).toContainText(text);
}

test("chat slot mounts post-hydration (fallback → live) and fills from load", async ({ page }) => {
  // Pre-hydration the layout SSRs the fallback; after hydration the slot mounts
  // over the app connection and `load` fills the panel (loads counter → 1).
  await gotoHydrated(page, "/dashboard");
  await expect(page.getByTestId("chat-panel")).toBeVisible();
  await expect(page.getByTestId("chat-who")).toContainText("you are");
  await expect(page.getByTestId("chat-loads")).toHaveText("loads: 1");
});

test("three-layer persistence: draft + messages survive tier 1/2/3", async ({ page }) => {
  await gotoHydrated(page, "/");

  // A confirmed message (instance state) and a live draft (React tree state).
  await sendChat(page, "keep me");
  await page.getByTestId("chat-draft").fill("unsent draft");

  // Stamp the live document — a full page load would wipe it; every soft tier
  // preserves it, proving the connection was never re-established.
  await page.evaluate(() => {
    (window as unknown as { __persist?: string }).__persist = "kept";
  });

  const stillLive = async () => {
    await expect(page.getByTestId("chat-draft")).toHaveValue("unsent draft"); // React tree
    await expect(page.getByTestId("chat-messages")).toContainText("keep me"); // instance
    const marker = await page.evaluate(
      () => (window as unknown as { __persist?: string }).__persist,
    );
    expect(marker).toBe("kept"); // no full reload → connection intact
  };

  // Tier 1: same-page props change (the schema-less todos filter, a `nav.patch`).
  await page.getByTestId("filter-done").click();
  await expect(page).toHaveURL(/[?&]filter=done/);
  await stillLive();

  // Tier 3: a route change (todos → item) over the same connection.
  await page.getByTestId("shell-nav").getByRole("link", { name: "item" }).click();
  await expect(page).toHaveURL(/\/item\/1$/);
  await stillLive();

  // Tier 2: same-pattern path change (/item/1 → /item/2).
  await page.getByTestId("go-2").click();
  await expect(page).toHaveURL(/\/item\/2$/);
  await stillLive();

  // Tier 3 again: another route change (item → stream).
  await page.getByTestId("shell-nav").getByRole("link", { name: "stream" }).click();
  await expect(page).toHaveURL(/\/stream$/);
  await stillLive();
});

test("cross-object bus: page rpc broadcasts to chat; exclude-self honored", async ({ page }) => {
  await gotoHydrated(page, "/dashboard");
  await expect(page.getByTestId("chat-panel")).toBeVisible();

  // The page (a different live object) broadcasts a notice onto the chat channel.
  await page.getByTestId("notify").click();

  // The chat slot's `.on("panel.notice")` renders it (cross-object delivery).
  await expect(page.getByTestId("chat-messages")).toContainText("ping");
  // Exactly one — no double-apply.
  await expect(page.getByTestId("chat-messages").getByText("ping")).toHaveCount(1);
  // Exclude-self: the broadcasting page never receives its own notice.
  await expect(page.getByTestId("page-notices").locator("li")).toHaveCount(0);
});

test("multiplayer: two contexts on the same channel see each other's messages", async ({
  browser,
}) => {
  const contexts: BrowserContext[] = [await browser.newContext(), await browser.newContext()];
  const [alice, bob] = await Promise.all(contexts.map((c) => c.newPage()));

  await gotoHydrated(alice as Page, "/dashboard");
  await gotoHydrated(bob as Page, "/dashboard");
  await expect((alice as Page).getByTestId("chat-panel")).toBeVisible();
  await expect((bob as Page).getByTestId("chat-panel")).toBeVisible();

  // Alice sends — she sees it (optimistic + confirmed), Bob sees it (bus `.on`).
  await sendChat(alice as Page, "hi from alice");
  await expect((bob as Page).getByTestId("chat-messages")).toContainText("hi from alice");

  // And back the other way.
  await sendChat(bob as Page, "hi from bob");
  await expect((alice as Page).getByTestId("chat-messages")).toContainText("hi from bob");

  await Promise.all(contexts.map((c) => c.close()));
});

test("a routed copy in another tab is its OWN instance (per-stream isolation)", async ({
  browser,
}) => {
  // One context (one session), two tabs: a dashboard tab embeds /item/1 as a
  // slot; a second tab routes to the real /item/1. Instances are stream-scoped
  // (ADR 0003), so the tabs hold SEPARATE instances of the same identity — a
  // mutation in one tab must NOT bleed into the other (cross-tab sync is the
  // bus's job, and the item route doesn't broadcast).
  const context = await browser.newContext();
  const dash = await context.newPage();
  const routed = await context.newPage();

  await gotoHydrated(dash, "/dashboard");
  await gotoHydrated(routed, "/item/1");
  const embedded = dash.getByTestId("board-embed");
  await expect(embedded.getByTestId("item-label")).toHaveText("Item 1");
  await expect(routed.getByTestId("item-label")).toHaveText("Item 1");

  // Mutate through the embedded slot: only THIS tab's instance changes.
  await embedded.getByTestId("bump").click();
  await expect(embedded.getByTestId("item-label")).toHaveText("Item 1!");
  await expect(routed.getByTestId("item-label")).toHaveText("Item 1");

  await context.close();
});

test("each tab loads its own instance (per-stream, Phoenix-style)", async ({ browser }) => {
  const context = await browser.newContext();
  const tab1 = await context.newPage();
  await gotoHydrated(tab1, "/dashboard");
  await expect(tab1.getByTestId("chat-loads")).toHaveText("loads: 1");

  // Second tab, same session: its OWN chat instance (ADR 0003), so its loader
  // runs once for it — and tab 1's instance is untouched.
  const tab2 = await context.newPage();
  await gotoHydrated(tab2, "/dashboard");
  await expect(tab2.getByTestId("chat-loads")).toHaveText("loads: 1");
  await expect(tab1.getByTestId("chat-loads")).toHaveText("loads: 1");

  await context.close();
});
