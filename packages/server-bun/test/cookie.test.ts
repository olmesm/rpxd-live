import { describe, expect, it } from "vitest";
import { timingSafeEqualStr } from "../src/cookie.ts";

describe("timingSafeEqualStr (#61)", () => {
  it("returns true for equal strings", () => {
    expect(timingSafeEqualStr("abc123", "abc123")).toBe(true);
  });

  it("returns false for different-length strings", () => {
    expect(timingSafeEqualStr("abc", "abcd")).toBe(false);
  });

  it("returns false for same-length, different strings", () => {
    expect(timingSafeEqualStr("abc123", "abc124")).toBe(false);
  });

  it("returns true for two empty strings", () => {
    expect(timingSafeEqualStr("", "")).toBe(true);
  });
});
