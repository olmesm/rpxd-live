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

/**
 * Wait until the app connection is fully settled — every store multiplexed on it
 * is live with no in-flight rpc — signalled by the framework stamping
 * `<html data-rpxd-synced>` (see `LiveConnection.synced`). The marker flickers
 * OFF during an in-flight rpc and back ON at ack, so calling this AFTER an action
 * (submit, toggle, filter) is a deterministic "the write landed and persisted"
 * wait — the drop-in for the fixed `waitForTimeout` guesses that raced variable
 * ack/persistence latency under the shared dev server's parallel load.
 */
export async function awaitSynced(page: Page): Promise<void> {
  await page.waitForSelector("html[data-rpxd-synced]", { state: "attached" });
}
