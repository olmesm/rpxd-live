import { defineConfig } from "@playwright/test";

/**
 * E2e acceptance suite (§17): Playwright against examples/todos via a real
 * `rpxd dev` process. Set RPXD_CHROMIUM to a chromium binary to skip the
 * managed browser download (used in sandboxed dev environments).
 */
export default defineConfig({
  testDir: "./tests",
  timeout: 30_000,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "line" : "list",
  use: {
    baseURL: "http://localhost:4517",
    ...(process.env.RPXD_CHROMIUM
      ? { launchOptions: { executablePath: process.env.RPXD_CHROMIUM } }
      : {}),
  },
  webServer: {
    command: "bun ../../packages/cli/src/cli.ts dev",
    cwd: "../examples/todos",
    port: 4517,
    env: { PORT: "4517" },
    reuseExistingServer: !process.env.CI,
    stdout: "ignore",
  },
});
