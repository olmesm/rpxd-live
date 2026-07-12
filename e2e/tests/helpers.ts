import type { Page } from "@playwright/test";

/**
 * Navigate and wait for React hydration before returning. The framework's
 * client entry stamps `<html data-rpxd-hydrated>` after `hydrateRoot`
 * commits; interacting before that point loses clicks (no handler attached
 * yet) or falls through to a native form submit — the root cause of the
 * flaky auth/chat/import runs on slow CI boots. Any spec that clicks or
 * types right after navigation should come through here.
 */
export async function gotoHydrated(page: Page, path: string): Promise<void> {
  await page.goto(path);
  await page.waitForSelector("html[data-rpxd-hydrated]", { state: "attached" });
}
