import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // test-bun/** run under `bun test` (they exercise the Bun runtime itself);
    // e2e/** runs under Playwright. Vitest owns package unit tests only.
    include: ["packages/*/test/**/*.test.{ts,tsx}", "packages/*/src/**/*.test.{ts,tsx}"],
    exclude: ["**/node_modules/**", "**/test-bun/**", "e2e/**"],
    // NODE_ENV is otherwise unset under Vitest; run as development so the
    // secure-by-default secret guard (S1, isDev()) warns instead of throwing
    // for the many existing no-secret handler constructions in this suite.
    env: { NODE_ENV: "development" },
    // Type tests (§17 / spec type guarantees): *.test-d.ts files are
    // compiled, not executed.
    typecheck: {
      enabled: true,
      include: ["packages/*/test/**/*.test-d.ts"],
    },
  },
});
