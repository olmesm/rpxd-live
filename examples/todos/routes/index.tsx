import type { RenderProps } from "@rpxd/client";
import { live } from "@rpxd/core";
import type { Draft } from "immer";

interface Todo {
  id: string;
  text: string;
  done: boolean;
}
interface TodosState {
  todos: Todo[];
}

let counter = 0;

export default live("/")({
  mount: async () => ({
    todos: [{ id: "t0", text: "Try rpxd", done: false }] as Todo[],
  }),
  rpc: {
    add: {
      optimistic: (state: TodosState, { text }: { text: string }, ctx) => {
        state.todos.push({ id: ctx.tempId(), text, done: false });
      },
      async handler(state: Draft<TodosState>, { text }: { text: string }) {
        state.todos.push({ id: `srv-${++counter}`, text, done: false });
      },
    },
    toggle: {
      optimistic: (state: TodosState, { id }: { id: string }) => {
        const todo = state.todos.find((t) => t.id === id);
        if (todo) todo.done = !todo.done;
      },
      async handler(state: Draft<TodosState>, { id }: { id: string }) {
        const todo = state.todos.find((t) => t.id === id);
        if (todo) todo.done = !todo.done;
      },
    },
  },
})(({ state, rpc, sync, keyOf }: RenderProps<TodosState>) => (
  <main>
    <h1>rpxd todos</h1>
    <ul data-testid="todos">
      {state.todos.map((t) => (
        <li key={keyOf(t.id)} data-id={t.id}>
          <label>
            <input type="checkbox" checked={t.done} onChange={() => rpc.toggle?.({ id: t.id })} />
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
        if (input.value.trim()) void rpc.add?.({ text: input.value.trim() });
        input.value = "";
      }}
    >
      <input name="text" placeholder="What needs doing?" />
      <button type="submit">Add</button>
    </form>
    {sync.pending && <span data-testid="pending">saving…</span>}
  </main>
));
