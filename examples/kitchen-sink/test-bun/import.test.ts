/**
 * `/import` — CSV import with per-row progress and `.onError` repair.
 *
 * Two layers: the pure {@link parseCsv} (no rpxd, no browser) and the route
 * under `testLive` (real queue, real patches). The route test is the payoff —
 * it proves the `.onError` mutator repairs state (`importing → false`, `error`
 * populated) *and* that the repair rides the rejected rpc's error ack, exactly
 * as the wire protocol and the routes guide describe.
 */
import { describe, expect, it } from "bun:test";
import { testLive } from "@rpxd/testing";
import { parseCsv } from "../domain/import";
import route from "../routes/import.tsx";

const VALID = "task,note\nwrite tests,first\nwrite code,second\nship it,third";
// row 3 ("broken") has one column where the header declares two — throws
// mid-stream, *after* the first two rows have already imported.
const POISON = "task,note\nwrite tests,first\nwrite code,second\nbroken\nship it,fourth";

describe("parseCsv", () => {
  it("parses a header + comma-separated rows into keyed records", () => {
    expect([...parseCsv(VALID)]).toEqual([
      { task: "write tests", note: "first" },
      { task: "write code", note: "second" },
      { task: "ship it", note: "third" },
    ]);
  });

  it("skips blank lines", () => {
    expect([...parseCsv("task,note\n\nonly,row\n")]).toEqual([{ task: "only", note: "row" }]);
  });

  it("throws a descriptive error on a wrong-column-count row", () => {
    expect(() => [...parseCsv(POISON)]).toThrow(/row 3 has 1 column/);
  });

  it("throws when there is no header row", () => {
    expect(() => [...parseCsv("   \n\n")]).toThrow(/no header row/);
  });
});

describe("import route", () => {
  it("imports every row: imported === n, importing cleared, no error", async () => {
    const t = await testLive(route);
    await t.rpc.import({ csv: VALID });
    await t.settled();

    expect(t.state.imported).toBe(3);
    expect(t.state.rows).toHaveLength(3);
    expect(t.state.importing).toBe(false);
    expect(t.state.error).toBeNull();
    await t.dispose();
  });

  it("onError repairs state on a mid-file poison row, and rides the error ack", async () => {
    const t = await testLive(route);

    // the rpc rejects (the handler threw parsing the bad row)...
    await expect(t.rpc.import({ csv: POISON })).rejects.toThrow(/row 3 has 1 column/);
    await t.settled();

    // ...and the .onError mutator already repaired state: importing cleared,
    // error populated with the count of rows that made it in first.
    expect(t.state.importing).toBe(false);
    expect(t.state.imported).toBe(2);
    expect(t.state.error).toBe(
      "import failed after 2 rows: row 3 has 1 column(s), expected 2 (task, note)",
    );

    // the repair patches rode the error ack (same envelope as the rejection).
    const ack = t.envelopes.filter((e) => e.error).at(-1);
    expect(ack?.error?.message).toMatch(/row 3 has 1 column/);
    expect(ack?.patches?.length).toBeGreaterThan(0);
    await t.dispose();
  });
});
