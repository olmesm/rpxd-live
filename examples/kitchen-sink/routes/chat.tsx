import { live } from "@rpxd/core";

interface Message {
  id: string;
  text: string;
}

let messageCounter = 0;

/**
 * Multiplayer demo (§8): per-session instances coordinated over the pubsub
 * bus. Single-code-path pattern — the rpc only broadcasts (with
 * `{ self: true }`); ALL mutation happens in the `on` handler.
 */
export default live("/chat")
  .mount(async (_params, ctx) => {
    ctx.subscribe("chat:lobby");
    return { messages: [] as Message[] };
  })
  .rpc("send", (r) =>
    r.handler(async ({ text }: { text: string }, ctx) => {
      const message = { id: `m-${++messageCounter}`, text };
      ctx.broadcast("chat:lobby", "message.created", message, { self: true });
    }),
  )
  .on("message.created", (state, message: Message) => {
    state.messages.push(message);
  })
  .render(({ state, rpc }) => (
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
          if (input.value.trim()) void rpc.send({ text: input.value.trim() });
          input.value = "";
        }}
      >
        <input name="text" placeholder="Say something" />
        <button type="submit">Send</button>
      </form>
    </main>
  ));
