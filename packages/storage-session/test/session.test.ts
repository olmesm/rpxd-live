import { describe, expect, it, vi } from "vitest";
import { session } from "../src/index.ts";

describe("session storage adapter", () => {
  it("round-trips within the TTL and expires after it", () => {
    vi.useFakeTimers();
    try {
      const storage = session({ ttlMs: 1_000 });
      const snap = { state: { a: 1 }, session: {}, seq: 1, version: "v1" };
      storage.set("k", snap);
      expect(storage.get("k")).toEqual(snap);

      vi.advanceTimersByTime(900);
      expect(storage.get("k")).toEqual(snap);

      vi.advanceTimersByTime(200); // past TTL since last write
      expect(storage.get("k")).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("refreshes the TTL on write", () => {
    vi.useFakeTimers();
    try {
      const storage = session({ ttlMs: 1_000 });
      const snap = { state: {}, session: {}, seq: 1, version: "v1" };
      storage.set("k", snap);
      vi.advanceTimersByTime(900);
      storage.set("k", { ...snap, seq: 2 });
      vi.advanceTimersByTime(900);
      expect(storage.get("k")).toBeDefined(); // write reset the clock
    } finally {
      vi.useRealTimers();
    }
  });
});
