/**
 * Todos domain module — the service-layer boundary (Phoenix "context", kept
 * out of the `ctx` namespace on purpose; see `docs/domain-layer.md`).
 *
 * `routes/` calls these functions; only this layer imports `db`. Business logic
 * and persistence live here, so handlers stay thin orchestration and the whole
 * module unit-tests without rpxd (see `test-bun/domain-todos.test.ts`). Any DB
 * transaction would open and close inside one of these functions — never spans
 * a handler's awaits.
 *
 * Every function takes a {@link Scope} first — the rpxd echo of Phoenix's
 * `Scope`: who is acting, threaded from `ctx.session` into scoped queries.
 * Functions are async to mirror a real data layer: routes `await` them.
 */
import { db, type TodoRow } from "../db";
import type { Scope } from "./scope";

export type { Scope, ScopeUser } from "./scope";
export type { TodoRow };

/**
 * The row owner: a signed-in user's todos follow their identity across
 * sessions/devices; an anonymous visitor's are scoped to their session id.
 */
function ownerOf(scope: Scope): string {
  return scope.user?.id ?? scope.sid;
}

/** Load every todo in scope. */
export async function listTodos(scope: Scope): Promise<TodoRow[]> {
  return db.todos.all(ownerOf(scope));
}

/** Create a todo in scope and return the persisted row (with its server id). */
export async function addTodo(scope: Scope, text: string): Promise<TodoRow> {
  return db.todos.insert(ownerOf(scope), text);
}

/** Toggle a scoped todo's `done`; returns the updated row, or `undefined` if it's gone. */
export async function toggleTodo(scope: Scope, id: string): Promise<TodoRow | undefined> {
  return db.todos.toggle(ownerOf(scope), id);
}
