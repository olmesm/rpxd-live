import { describe, expect, it } from "vitest";
import { isDev } from "../src/env.ts";

/**
 * Secure-by-default gate (see CLAUDE.md "Conventions"): `isDev()` is a
 * positive check — TRUE only for the exact string `"development"`. Every
 * other value (unset, a typo, "staging", "test", "production", wrong case)
 * must resolve to `false` so fail-closed guards stay engaged.
 */
describe("isDev", () => {
  function withNodeEnv(value: string | undefined, run: () => void): void {
    const prev = process.env.NODE_ENV;
    try {
      if (value === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = value;
      run();
    } finally {
      if (prev === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = prev;
    }
  }

  it('is true only for exactly "development"', () => {
    withNodeEnv("development", () => {
      expect(isDev()).toBe(true);
    });
  });

  it("is false when NODE_ENV is unset", () => {
    withNodeEnv(undefined, () => {
      expect(isDev()).toBe(false);
    });
  });

  it('is false for "production"', () => {
    withNodeEnv("production", () => {
      expect(isDev()).toBe(false);
    });
  });

  it('is false for "staging"', () => {
    withNodeEnv("staging", () => {
      expect(isDev()).toBe(false);
    });
  });

  it('is false for "Development" (case-sensitive)', () => {
    withNodeEnv("Development", () => {
      expect(isDev()).toBe(false);
    });
  });

  it('is false for "" (empty string)', () => {
    withNodeEnv("", () => {
      expect(isDev()).toBe(false);
    });
  });
});
