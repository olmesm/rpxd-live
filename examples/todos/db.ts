/**
 * In-memory stand-in for a real database (Prisma, Drizzle, `bun:sqlite`, …).
 *
 * The framework never touches this file — it's plain userland. Only the domain
 * layer (`domain/`) imports it; `routes/` never does. Swap this for a real
 * client and nothing under `routes/` changes, because routes talk to `domain/`,
 * not to the db. See `docs/domain-layer.md`.
 *
 * Rows are keyed by `owner` — the demo scopes every query to the acting session
 * (spec §1's `findMany({ where: { orgId } })`), so one session never sees
 * another's todos. Queries return fresh row objects (not internal references)
 * so instance state never aliases the store — the contract a real db gives you.
 */

/** A persisted todo row. */
export interface TodoRow {
  id: string;
  text: string;
  done: boolean;
}

// One table per owner. A real db would be one shared table with an `owner`
// column; the in-memory version nests the maps.
const tables = new Map<string, Map<string, TodoRow>>();

let seq = 0;

function tableFor(owner: string): Map<string, TodoRow> {
  let table = tables.get(owner);
  if (!table) {
    // A brand-new owner starts with a seeded starter row.
    table = new Map([["t0", { id: "t0", text: "Try rpxd", done: false }]]);
    tables.set(owner, table);
  }
  return table;
}

export const db = {
  todos: {
    /** All of `owner`'s rows, as detached copies. */
    all(owner: string): TodoRow[] {
      return [...tableFor(owner).values()].map((row) => ({ ...row }));
    },
    /** Insert a row for `owner` with a server-assigned id; returns a copy. */
    insert(owner: string, text: string): TodoRow {
      const row: TodoRow = { id: `srv-${++seq}`, text, done: false };
      tableFor(owner).set(row.id, row);
      return { ...row };
    },
    /** Flip `done` for one of `owner`'s rows; returns the updated copy, or `undefined`. */
    toggle(owner: string, id: string): TodoRow | undefined {
      const row = tableFor(owner).get(id);
      if (!row) return undefined;
      row.done = !row.done;
      return { ...row };
    },
  },
};
