/**
 * Node SQLite adapter (`better-sqlite3`) — the Node-runtime counterpart to the
 * `bun:sqlite` adapter (test-bun/sqlite.test.ts). Runs on the Vitest (Node)
 * lane; `better-sqlite3` is a native module, no Bun runtime required.
 */
import type { LiveDefinition } from "@rpxd/core";
import { LiveInstance } from "@rpxd/core";
import { describe, expect, it } from "vitest";
import { sqliteNode } from "../src/node.ts";

describe("sqliteNode storage adapter", () => {
  it("round-trips snapshots", () => {
    const storage = sqliteNode(":memory:");
    const snap = { state: { a: [1, 2] }, session: { filter: "x" }, seq: 7, version: "v1" };
    storage.set("k1", snap);
    expect(storage.get("k1")).toEqual(snap);

    storage.set("k1", { ...snap, seq: 8 });
    expect((storage.get("k1") as { seq: number }).seq).toBe(8);

    storage.delete("k1");
    expect(storage.get("k1")).toBeUndefined();
  });

  it("backs a LiveInstance write-through + session continuity (§9)", async () => {
    const storage = sqliteNode(":memory:");
    const def: LiveDefinition<{ n: number }, "/", { userId?: string }> = {
      mount: async () => ({ n: 0 }),
      params: async ({ filter }, ctx) => {
        ctx.patchState((s) => {
          s.n = filter === "done" ? 1 : 0;
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
    await first.setSearch({ filter: "done" });
    expect(first.state.n).toBe(1);
    await first.dispose();

    const second = await LiveInstance.create({
      id: "b",
      def,
      params: {},
      session: {} as { userId?: string },
      storage,
      storageKey: "sess:/",
    });
    expect(second.session.userId).toBe("u1"); // session survived through sqlite
    expect(second.seq).toBeGreaterThan(1); // seq continued
    expect(second.state.n).toBe(0); // cold wake re-mounts
    await second.setSearch({ filter: "done" });
    expect(second.state.n).toBe(1);
  });
});
