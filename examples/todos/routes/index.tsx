import { live } from "@rpxd/core";
import { addTodo, listTodos, scopeFrom, toggleTodo } from "../domain/todos";

// Data access goes through the domain layer, never `db` directly (see
// docs/domain-layer.md). Handlers stay thin: derive the scope from
// ctx.session, call the domain fn, then patchState.
export default live("/")
  .mount(async (_params, ctx) => ({ todos: await listTodos(scopeFrom(ctx.session)) }))
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
  .render(({ state, rpc, sync, keyOf }) => (
    <main>
      <h1>rpxd todos</h1>
      <ul data-testid="todos">
        {state.todos.map((t) => (
          <li key={keyOf(t.id)} data-id={t.id}>
            <label>
              <input type="checkbox" checked={t.done} onChange={() => rpc.toggle({ id: t.id })} />
              <span style={t.done ? { textDecoration: "line-through" } : undefined}>{t.text}</span>
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
  ));
