import { live } from "@rpxd/core";
import { scopeFrom } from "../domain/scope";
import { addTodo, listTodos, type TodoFilter, type TodoRow, toggleTodo } from "../domain/todos";

const FILTERS: TodoFilter[] = ["all", "active", "done"];
const asFilter = (v: string | undefined): TodoFilter =>
  v === "active" || v === "done" ? v : "all";

// Data access goes through the domain layer, never `db` directly (see
// docs/domain-layer.md). Handlers stay thin: derive the scope from
// ctx.session, call the domain fn, then patchState.
//
// `mount` sets up the URL-invariant shell; `params` is the loader (§7) — the
// single place the (filtered) list is fetched, on first paint and on every
// `nav.patch`. `blockSsr` keeps the first document crawlable/data-complete.
export default live("/")
  .mount(async () => ({ todos: [] as TodoRow[], filter: "all" as TodoFilter, loading: true }))
  .params(
    async ({ filter }, ctx) => {
      const next = asFilter(filter);
      // Synchronous projection: the tab flips instantly and the previous
      // window stays visible (keepPreviousData) while the query runs.
      ctx.patchState((s) => {
        s.filter = next;
        s.loading = true;
      });
      const todos = await listTodos(scopeFrom(ctx.session), { filter: next });
      ctx.patchState((s) => {
        s.todos = todos;
        s.loading = false;
      });
    },
    { blockSsr: true },
  )
  .rpc("add", (r) =>
    r
      .optimistic((state, { text }: { text: string }, ctx) => {
        state.todos.push({ id: ctx.tempId(), text, done: false });
      })
      .handler(async ({ text }, ctx) => {
        const todo = await addTodo(scopeFrom(ctx.session), text);
        ctx.patchState((s) => {
          s.todos.push(todo);
        });
      }),
  )
  .rpc("toggle", (r) =>
    r
      .optimistic((state, { id }: { id: string }) => {
        const todo = state.todos.find((t) => t.id === id);
        if (todo) todo.done = !todo.done;
      })
      .handler(async ({ id }, ctx) => {
        await toggleTodo(scopeFrom(ctx.session), id);
        ctx.patchState((s) => {
          const todo = s.todos.find((t) => t.id === id);
          if (todo) todo.done = !todo.done;
        });
      }),
  )
  .render(({ state, session, rpc, sync, nav, keyOf }) => {
    const { user } = scopeFrom(session);
    return (
      <main>
        <h1>rpxd todos</h1>
        <nav data-testid="auth">
          {user ? (
            <>
              <span data-testid="who">signed in as {user.email}</span>{" "}
              <button
                type="button"
                data-testid="sign-out"
                onClick={async () => {
                  // Better Auth wants a JSON content-type and body (even empty).
                  await fetch("/api/auth/sign-out", {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: "{}",
                  });
                  window.location.assign("/");
                }}
              >
                sign out
              </button>
            </>
          ) : (
            <a href="/login" data-testid="sign-in-link">
              sign in
            </a>
          )}
        </nav>
        {/* View changes are `nav.patch` only — URL updates, the loader reruns. */}
        <nav data-testid="filters">
          {FILTERS.map((f) => (
            <button
              key={f}
              type="button"
              data-testid={`filter-${f}`}
              aria-current={state.filter === f}
              onClick={() => nav.patch({ filter: f })}
            >
              {f}
            </button>
          ))}
        </nav>
        <ul data-testid="todos" aria-busy={state.loading}>
          {state.todos.map((t) => (
            <li key={keyOf(t.id)} data-id={t.id}>
              <label>
                <input type="checkbox" checked={t.done} onChange={() => rpc.toggle({ id: t.id })} />
                <span style={t.done ? { textDecoration: "line-through" } : undefined}>
                  {t.text}
                </span>
              </label>
            </li>
          ))}
        </ul>
        <form
          data-testid="add-form"
          onSubmit={(e) => {
            e.preventDefault();
            const input = e.currentTarget.elements.namedItem("text") as HTMLInputElement;
            if (input.value.trim()) void rpc.add({ text: input.value.trim() });
            input.value = "";
          }}
        >
          <input name="text" placeholder="What needs doing?" />
          <button type="submit">Add</button>
        </form>
        {sync.pending && <span data-testid="pending">saving…</span>}
      </main>
    );
  });
