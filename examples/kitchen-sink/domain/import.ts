/**
 * CSV import domain module — the pure part, testable without rpxd or a browser.
 *
 * `routes/import.tsx` (the edge) calls {@link parseCsv} and turns each yielded
 * row into a `patchState` tick; this module owns the parsing/validation. It's a
 * **generator**, not an array-returning fn, on purpose: the route iterates it
 * with `for (const row of parseCsv(csv))`, so the rows before a malformed one
 * are imported (and counted) *before* the bad row throws mid-stream — which is
 * exactly what makes the route's `.onError` repair ("failed after N rows")
 * meaningful. No dependencies.
 */

/** One parsed CSV record: header column → cell value. */
export type CsvRow = Record<string, string>;

const cells = (line: string): string[] => line.split(",").map((c) => c.trim());

/**
 * Parse a CSV string (a header row followed by comma-separated data rows) into
 * a stream of {@link CsvRow}s. Blank lines are skipped. Yields lazily — the
 * consumer sees each good row before a later malformed row throws.
 *
 * @throws {Error} if the input has no header row, or a data row's column count
 *   doesn't match the header's.
 *
 * @example
 * ```ts
 * const rows = [...parseCsv("task,note\nship,soon")];
 * // [{ task: "ship", note: "soon" }]
 * ```
 */
export function* parseCsv(csv: string): Generator<CsvRow> {
  // Keep original indices so a thrown error names the *physical* line the
  // user sees in their file, not an index into a blank-line-filtered array.
  const lines = csv
    .split("\n")
    .map((line, index) => ({ line: line.trim(), lineNo: index + 1 }))
    .filter(({ line }) => line.length > 0);
  if (lines.length === 0) throw new Error("csv has no header row");

  const header = cells((lines[0] as { line: string }).line);
  for (const { line, lineNo } of lines.slice(1)) {
    const values = cells(line);
    if (values.length !== header.length) {
      throw new Error(
        `line ${lineNo} has ${values.length} column(s), expected ${header.length} (${header.join(", ")})`,
      );
    }
    const row: CsvRow = {};
    header.forEach((column, j) => {
      row[column] = values[j] as string;
    });
    yield row;
  }
}
