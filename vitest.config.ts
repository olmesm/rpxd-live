import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // test-bun/** run under `bun test` (they exercise the Bun runtime itself);
    // e2e/** runs under Playwright. Vitest owns package unit tests only.
    include: ["packages/*/test/**/*.test.{ts,tsx}", "packages/*/src/**/*.test.{ts,tsx}"],
    exclude: ["**/node_modules/**", "**/test-bun/**", "e2e/**"],
    // Type tests (§17 / spec type guarantees): *.test-d.ts files are
    // compiled, not executed.
    typecheck: {
      enabled: true,
      include: ["packages/*/test/**/*.test-d.ts"],
    },
  },
});
