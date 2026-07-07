import type { RenderProps } from "@rpxd/client";
import { type EventHandler, live, type RpcCtx } from "@rpxd/core";
import type { Draft } from "immer";

interface Message {
  id: string;
  text: string;
}
interface ChatState {
  messages: Message[];
}
type Ctx = RpcCtx<Record<never, string>, Record<string, unknown>>;

let messageCounter = 0;

/**
 * Multiplayer demo (§8): per-session instances coordinated over the pubsub
 * bus. Single-code-path pattern — the rpc only broadcasts (with
 * `{ self: true }`); ALL mutation happens in the `on:` handler.
 */
export default live("/chat")({
  mount: async (_params, ctx) => {
    ctx.subscribe("chat:lobby");
    return { messages: [] as Message[] };
  },
  rpc: {
    async send(_state: Draft<ChatState>, { text }: { text: string }, ctx: Ctx) {
      const message = { id: `m-${++messageCounter}`, text };
      ctx.broadcast("chat:lobby", "message.created", message, { self: true });
    },
  },
  on: {
    "message.created": ((state, message: Message) => {
      state.messages.push(message);
    }) as EventHandler<ChatState, Record<never, string>, Record<string, unknown>>,
  },
})(({ state, rpc }: RenderProps<ChatState>) => (
  <main>
    <h1>rpxd chat</h1>
    <ul data-testid="messages">
      {state.messages.map((m) => (
        <li key={m.id}>{m.text}</li>
      ))}
    </ul>
    <form
      onSubmit={(e) => {
        e.preventDefault();
        const input = e.currentTarget.elements.namedItem("text") as HTMLInputElement;
        if (input.value.trim()) void rpc.send?.({ text: input.value.trim() });
        input.value = "";
      }}
    >
      <input name="text" placeholder="Say something" />
      <button type="submit">Send</button>
    </form>
  </main>
));
