/** Runs under `bun test` — bun:sqlite is a Bun-runtime API. */
import { describe, expect, it } from "bun:test";
import type { LiveDefinition } from "@rpxd/core";
import { LiveInstance } from "@rpxd/core";
import { sqlite } from "../src/index.ts";

describe("sqlite storage adapter", () => {
  it("round-trips snapshots", () => {
    const storage = sqlite(":memory:");
    const snap = { state: { a: [1, 2] }, session: { filter: "x" }, seq: 7, version: "v1" };
    storage.set("k1", snap);
    expect(storage.get("k1")).toEqual(snap);

    storage.set("k1", { ...snap, seq: 8 });
    expect((storage.get("k1") as { seq: number }).seq).toBe(8);

    storage.delete("k1");
    expect(storage.get("k1")).toBeUndefined();
  });

  it("close() releases the db handle it owns (graceful shutdown)", () => {
    const storage = sqlite(":memory:");
    storage.set("k", { state: {}, session: {}, seq: 1, version: "v1" });
    expect(storage.close).toBeDefined();
    storage.close?.();
    expect(() => storage.get("k")).toThrow(); // closed handle → further ops throw
  });

  it("backs a LiveInstance write-through + session continuity (§9)", async () => {
    const storage = sqlite(":memory:");
    // Filter is view state → the `load` loader writes page state (§7). Page
    // state is rebuilt from the URL on cold wake; the session slice + seq are
    // what sqlite carries across for continuity.
    const def: LiveDefinition<{ n: number }, "/", { userId?: string }> = {
      setup: () => ({ n: 0 }),
      load: async ({ search }, ctx) => {
        ctx.patchState((s) => {
          s.n = search.filter === "done" ? 1 : 0;
        });
      },
    };
    const first = await LiveInstance.create({
      id: "a",
      def,
      params: {},
      session: { userId: "u1" },
      storage,
      storageKey: "sess:/",
    });
    await first.load({ filter: "done" });
    expect(first.state.n).toBe(1); // loader wrote page state
    await first.dispose();

    const second = await LiveInstance.create({
      id: "b",
      def,
      params: {},
      session: {},
      storage,
      storageKey: "sess:/",
    });
    expect(second.session.userId).toBe("u1"); // session survived through sqlite
    expect(second.seq).toBeGreaterThan(1); // seq continued
    // Cold wake re-mounts (n back to 0); re-presenting the URL rebuilds it.
    expect(second.state.n).toBe(0);
    await second.load({ filter: "done" });
    expect(second.state.n).toBe(1);
  });
});
