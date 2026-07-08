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
 *
 * CI runs the four combos sequentially in one job (see ci.yml), each pointing
 * the HTML report and per-test output at a combo-specific dir via
 * PLAYWRIGHT_HTML_DIR / PLAYWRIGHT_OUTPUT_DIR so the uploaded artifact keeps
 * all four rather than the last one overwriting the rest.
 */
const transport = process.env.RPXD_TRANSPORT ?? "sse";
const rscFlag = process.env.RPXD_RSC === "false" ? "--no-rsc" : "--rsc";
const htmlDir = process.env.PLAYWRIGHT_HTML_DIR ?? "playwright-report";
const outputDir = process.env.PLAYWRIGHT_OUTPUT_DIR ?? "test-results";

export default defineConfig({
  testDir: "./tests",
  timeout: 30_000,
  retries: process.env.CI ? 1 : 0,
  outputDir,
  reporter: process.env.CI
    ? [["line"], ["html", { open: "never", outputFolder: htmlDir }]]
    : "list",
  use: {
    baseURL: "http://localhost:4517",
    // On the retry of a failing test, capture a trace + screenshot — that's what
    // makes the uploaded artifact useful for diagnosing a red run.
    trace: "on-first-retry",
    screenshot: "only-on-failure",
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
