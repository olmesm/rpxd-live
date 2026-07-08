import { defineConfig } from "@playwright/test";

/**
 * E2e acceptance suite (§17): Playwright against examples/todos via a real
 * `rpxd dev` process. Set RPXD_CHROMIUM to a chromium binary to skip the
 * managed browser download (used in sandboxed dev environments).
 *
 * The render/transport combination is driven by env so CI can matrix it
 * (§11 promises the transport is API-identical; §16 that rsc is opt-in):
 *   RPXD_TRANSPORT = sse | ws   (default sse)
 *   RPXD_RSC       = true | false (default true)
 * `rsc: false` disables rsc fields, so rsc-only specs (doc.spec) skip
 * themselves — see tests/doc.spec.ts.
 */
const transport = process.env.RPXD_TRANSPORT ?? "sse";
const rscFlag = process.env.RPXD_RSC === "false" ? "--no-rsc" : "--rsc";

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
    command: `bun ../../packages/cli/src/cli.ts dev --transport ${transport} ${rscFlag}`,
    cwd: "../examples/todos",
    port: 4517,
    env: { PORT: "4517" },
    reuseExistingServer: !process.env.CI,
    stdout: "ignore",
  },
});
