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

  it("backs a LiveInstance write-through + session continuity (§9)", async () => {
    const storage = sqlite(":memory:");
    const def: LiveDefinition<{ n: number }, "/", { filter?: string }> = {
      mount: async () => ({ n: 0 }),
      params: (session, { filter }) => {
        session.filter = filter ?? "all";
      },
    };
    const first = await LiveInstance.create({
      id: "a",
      def,
      params: {},
      session: {},
      storage,
      storageKey: "sess:/",
    });
    await first.setSearch({ filter: "done" });
    await first.dispose();

    const second = await LiveInstance.create({
      id: "b",
      def,
      params: {},
      session: {},
      storage,
      storageKey: "sess:/",
    });
    expect(second.session.filter).toBe("done"); // session survived through sqlite
    expect(second.seq).toBeGreaterThan(1); // seq continued
  });
});
