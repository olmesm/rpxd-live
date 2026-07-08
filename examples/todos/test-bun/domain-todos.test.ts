/**
 * The domain layer is plain functions over `db` — no `live()`, no ctx, no
 * harness. That testability is the point of the routes → domain → db split
 * (docs/domain-layer.md): the edge stays thin and the logic tests in isolation,
 * passing a plain {@link Scope} where a request would supply `ctx.session`.
 */
import { describe, expect, it } from "bun:test";
import { addTodo, listTodos, type Scope, toggleTodo } from "../domain/todos";

const scope: Scope = { sid: "test-session" };

describe("todos domain (no rpxd)", () => {
  it("seeds a starter todo for a new scope", async () => {
    const todos = await listTodos(scope);
    expect(todos.some((t) => t.text === "Try rpxd")).toBe(true);
  });

  it("adds a todo with a server id", async () => {
    const created = await addTodo(scope, "write docs");
    expect(created.id).toMatch(/^srv-/);
    expect(created.done).toBe(false);
    const todos = await listTodos(scope);
    expect(todos.some((t) => t.id === created.id && t.text === "write docs")).toBe(true);
  });

  it("toggles done", async () => {
    const created = await addTodo(scope, "toggle me");
    const toggled = await toggleTodo(scope, created.id);
    expect(toggled?.done).toBe(true);
  });

  it("keeps scopes isolated", async () => {
    await addTodo(scope, "only mine");
    const other = await listTodos({ sid: "someone-else" });
    expect(other.some((t) => t.text === "only mine")).toBe(false);
    expect(other.some((t) => t.text === "Try rpxd")).toBe(true);
  });

  it("scopes a signed-in user by identity, not session id", async () => {
    const alice = { sid: "session-A", user: { id: "u_alice", email: "a@x.com" } };
    await addTodo(alice, "alice task");
    // same user, a different session/tab → still sees their todos
    const aliceElsewhere = await listTodos({ sid: "session-B", user: alice.user });
    expect(aliceElsewhere.some((t) => t.text === "alice task")).toBe(true);
    // an anonymous visitor on session-A does NOT see alice's todos
    const anon = await listTodos({ sid: "session-A" });
    expect(anon.some((t) => t.text === "alice task")).toBe(false);
  });
});
