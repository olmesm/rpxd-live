/**
 * Todos domain module — the service-layer boundary (Phoenix "context").
 *
 * `routes/` calls these functions; only the domain layer touches the data
 * layer. Prisma is loaded **lazily and server-only**: `import.meta.env.SSR` is
 * a static `false` in the Vite client build, so `@prisma/client` (which uses
 * `node:crypto`) is tree-shaken out of the browser bundle even though a route
 * component imports this module. Queries scope by {@link Scope}.
 */
import type { Scope } from "./scope";

export type { Scope, ScopeUser } from "./scope";

/** A persisted todo row (the subset the UI needs). */
export interface TodoRow {
  id: string;
  text: string;
  done: boolean;
}

/** Which todos a view shows — URL view state (§7), driven by `nav.patch`. */
export type TodoFilter = "all" | "active" | "done";

const select = { id: true, text: true, done: true } as const;
// `srv-` ids mark server-confirmed rows (vs optimistic tempIds, §4).
const newId = () => `srv-${crypto.randomUUID()}`;

const doneWhere = (filter: TodoFilter): { done?: boolean } =>
  filter === "active" ? { done: false } : filter === "done" ? { done: true } : {};

const client = () => {
  if (import.meta.env.SSR) return import("../adapters/db").then((m) => m.db);
  throw new Error("db access is server-only");
};

/**
 * The row owner: a signed-in user's todos follow their identity across
 * sessions/devices; an anonymous visitor's are scoped to their session id.
 */
function ownerOf(scope: Scope): string {
  return scope.user?.id ?? scope.sid;
}

/**
 * Load todos in scope (oldest first), optionally filtered by `done`. A brand
 * new owner is seeded a starter row — but only on the unfiltered "all" view,
 * so an empty "done"/"active" window never spuriously seeds.
 */
export async function listTodos(
  scope: Scope,
  opts: { filter?: TodoFilter } = {},
): Promise<TodoRow[]> {
  const db = await client();
  const owner = ownerOf(scope);
  const filter = opts.filter ?? "all";
  const rows = await db.todo.findMany({
    where: { owner, ...doneWhere(filter) },
    orderBy: { created: "asc" },
    select,
  });
  if (rows.length > 0 || filter !== "all") return rows;
  // Seed keeps the default cuid (not a `srv-` id) so a seeded row is
  // distinguishable from a server-confirmed insert.
  return [await db.todo.create({ data: { owner, text: "Try rpxd" }, select })];
}

/** Create a todo in scope; returns the persisted row (with its server id). */
export async function addTodo(scope: Scope, text: string): Promise<TodoRow> {
  const db = await client();
  return db.todo.create({ data: { id: newId(), owner: ownerOf(scope), text }, select });
}

/** Toggle a scoped todo's `done`; returns the updated row, or `undefined` if absent. */
export async function toggleTodo(scope: Scope, id: string): Promise<TodoRow | undefined> {
  const db = await client();
  const row = await db.todo.findFirst({
    where: { id, owner: ownerOf(scope) },
    select: { done: true },
  });
  if (!row) return undefined;
  return db.todo.update({ where: { id }, data: { done: !row.done }, select });
}
