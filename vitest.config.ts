import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // spikes/** run under `bun test` (they exercise the Bun runtime itself);
    // e2e/** runs under Playwright. Vitest owns package unit tests only.
    include: ["packages/*/test/**/*.test.ts", "packages/*/src/**/*.test.ts"],
    exclude: ["**/node_modules/**", "spikes/**", "e2e/**"],
  },
});
