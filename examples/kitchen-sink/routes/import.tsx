import { live } from "@rpxd/core";
import { z } from "zod";
import { type CsvRow, parseCsv } from "../domain/import";
import { sleep } from "../lib/sleep";

/**
 * CSV import demo (§3, §5) — streaming progress *and* `.onError` recovery in one
 * route. The handler resets state, then iterates {@link parseCsv} row by row:
 * each `patchState` tick flushes a patch envelope, so rows appear in the browser
 * while the import runs (a small delay keeps the progression visible). Parsing is
 * lazy, so a malformed row throws *mid-stream* — after the good rows imported.
 *
 * That throw is the point: the whole rpc is all-or-nothing at the DB layer
 * (userland), but the live-object *state* is left mid-import. `.onError` is the
 * repair — a sync mutator whose patches ride the same error ack the rejection
 * travels on (§5): it clears `importing` and records how far we got. The route
 * keeps the imported rows in live-object state (no DB) — the demo is the
 * progress + failure path, not persistence.
 */

const SAMPLE = "task,note\nitem-1,write the failing test\nitem-2,make it pass\nitem-3,refactor";
// line 4 ("oops-no-note") is one column short of the `task,note` header, so the
// generator throws on it — after the first two rows have already imported.
const SAMPLE_WITH_BAD_ROW =
  "task,note\nitem-1,write the failing test\nitem-2,make it pass\noops-no-note\nitem-3,refactor";

export default live("/import")
  .setup(() => ({
    rows: [] as CsvRow[], // the row count is derived — rows.length, one fact, one field
    importing: false,
    error: null as string | null,
  }))
  .rpc("import", (r) =>
    r
      .input(z.object({ csv: z.string() }))
      .handler(async ({ csv }, ctx) => {
        ctx.patchState((s) => {
          s.rows = [];
          s.importing = true;
          s.error = null;
        });
        // Lazy iteration: a malformed row throws here, mid-loop, so the rows
        // before it have already been imported.
        for (const row of parseCsv(csv)) {
          await sleep(120); // artificial — makes the per-row progress visible
          ctx.patchState((s) => {
            s.rows.push(row);
          });
        }
        ctx.patchState((s) => {
          s.importing = false;
        });
      })
      // THE demonstration: when the handler throws (a poison row), this sync
      // mutator repairs state and its patches ride the error ack. `err` is
      // the serialized ack error (`{ name, message, rpc }`), not the raw throw.
      .onError((s, err) => {
        s.importing = false;
        const message = (err as { message?: string })?.message ?? String(err);
        s.error = `import failed after ${s.rows.length} rows: ${message}`;
      }),
  )
  .render(({ state, rpc, sync }) => (
    <main>
      <h1>rpxd import</h1>
      {/* Presets carry their own CSV, so the failure path is one click away. */}
      <nav data-testid="samples">
        <button
          type="button"
          data-testid="import-sample"
          disabled={state.importing}
          onClick={() => void rpc.import({ csv: SAMPLE })}
        >
          Import sample
        </button>
        <button
          type="button"
          data-testid="import-bad"
          disabled={state.importing}
          onClick={() => void rpc.import({ csv: SAMPLE_WITH_BAD_ROW })}
        >
          Import a file with a bad row
        </button>
      </nav>
      <form
        data-testid="import-form"
        onSubmit={(e) => {
          e.preventDefault();
          const field = e.currentTarget.elements.namedItem("csv") as HTMLTextAreaElement;
          if (field.value.trim()) void rpc.import({ csv: field.value });
        }}
      >
        <textarea
          name="csv"
          rows={5}
          placeholder={"task,note\nwrite tests,first"}
          defaultValue={SAMPLE}
        />
        <button type="submit" disabled={state.importing}>
          Import CSV
        </button>
      </form>
      {state.importing && <span data-testid="importing">importing…</span>}
      {sync.pending && <span data-testid="pending">syncing…</span>}
      {state.error && (
        <p data-testid="error" role="alert">
          {state.error}
        </p>
      )}
      <p data-testid="count">imported {state.rows.length} rows</p>
      <ul data-testid="items">
        {state.rows.map((row, i) => (
          // Rows have no natural id (raw CSV) — index key is fine for a
          // render-only list that's fully replaced each import.
          // biome-ignore lint/suspicious/noArrayIndexKey: append-only render list
          <li key={i}>{Object.values(row).join(", ")}</li>
        ))}
      </ul>
    </main>
  ));
