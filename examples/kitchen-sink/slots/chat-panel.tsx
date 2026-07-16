import { live } from "@rpxd/core";
import { type ReactElement, useState } from "react";
import { appendChatMessage, type ChatMessage, chatHistory } from "../domain/chat";
import { scopeFrom } from "../domain/scope";

export type { ChatMessage, PanelNotice } from "../domain/chat";

/**
 * The dashboard's persistent chat panel (ADR 0002 item 16) — a prop-addressed
 * live object mounted as a `<LiveSlot>` from `routes/__layout.tsx`, so it
 * survives every navigation (instance, connection, and React tree all persist).
 *
 * It is the doctrine's **positive** case: chat has its own lifecycle — its own
 * bus topic (`panel:${channel}`), its own rpcs, its own multiplayer scope — so
 * it earns a slot. The message list *inside* it is the **negative** case: rows
 * live as plain `state.messages` on this one aggregate, NOT one `<LiveSlot>` per
 * message. A list of slots would be a missing aggregate — see "Aggregates, not
 * rows".
 *
 * `$channel` is identity (a change remounts). This demo keeps it static
 * ("lobby") because a layout has no URL awareness.
 */
export default live("/chat-panel/$channel")
  .setup((ctx) => {
    // Own multiplayer scope: one topic per channel, joined once at setup.
    ctx.subscribe(`panel:${ctx.params.channel}`);
    const scope = scopeFrom(ctx.session);
    return {
      channel: ctx.params.channel,
      // Session in state (who is chatting) — read once from ctx.session.
      who: scope.user?.email ?? "guest",
      // NEGATIVE CASE (doctrine): the message list is plain state on this ONE
      // live object. Do NOT reach for a <LiveSlot> per row.
      messages: [] as ChatMessage[],
      // Load probe (item 8): warm reuse across a second tab skips `load`, so this
      // stays 1 — the zero-redundant-loads acceptance test reads it.
      loads: 0,
      // Streaming "agent reply" target — grows via append patches (see `agent`).
      agentReply: "",
      replying: false,
    };
  })
  .load(async (_url, ctx) => {
    // Canary: this literal lives only in the server-only `load` body. The
    // client-build strip transform (item 5) stubs this handler, so the string
    // must appear in zero `dist/client` assets (asserted in build-start.test).
    const CANARY = "CHAT_SLOT_SERVER_ONLY_a17c93";
    void CANARY;
    const history = await chatHistory(ctx.params.channel);
    ctx.patchState((s) => {
      s.loads += 1;
      s.messages = history;
    });
  })
  .rpc("send", (r) =>
    r
      // Optimistic append with a tempId — the line paints instantly; the server
      // id lands later and `keyOf` links them (no remount), exactly like todos.
      .optimistic((state, { text }: { text: string }, ctx) => {
        state.messages.push({ id: ctx.tempId(), text, from: state.who });
      })
      .handler(async ({ text }, ctx) => {
        const row = await appendChatMessage(ctx.params.channel, { text, from: ctx.state.who });
        ctx.patchState((s) => {
          s.messages.push(row);
        });
        // Fan out to the OTHER sessions on this channel (exclude-self default —
        // the sender already has the row via optimistic + this patchState).
        ctx.broadcast(`panel:${ctx.params.channel}`, "panel.message", row);
      }),
  )
  .rpc("agent", (r) =>
    r.handler(async (_payload, ctx) => {
      ctx.patchState((s) => {
        s.agentReply = "";
        s.replying = true;
      });
      // Deterministic token stream — suffix growth compiles to `append` ops, so
      // each token is O(delta) on the wire (the streaming demo, inside chat).
      for (const token of "thinking about it now".split(" ")) {
        if (ctx.signal.aborted) break;
        await new Promise((res) => setTimeout(res, 60));
        ctx.patchState((s) => {
          s.agentReply += `${token} `;
        });
      }
      ctx.patchState((s) => {
        s.replying = false;
      });
    }),
  )
  // Multiplayer: another session's message arrives over the bus.
  .on("panel.message", (state, message) => {
    state.messages.push(message);
  })
  // Cross-object bus: a PAGE (a different live object) broadcasts a notice onto
  // this channel; the chat renders it as a system line. The page never sees its
  // own broadcast (exclude-self), so it can't double-apply.
  .on("panel.notice", (state, notice) => {
    state.messages.push({
      id: `notice-${state.messages.length}`,
      text: notice.text,
      from: "system",
    });
  })
  .render((props) => <ChatPanelView {...props} />);

/**
 * The chat view. The draft input is **controlled React state** — the local tree
 * a slot's persistence must preserve across navigation (the three-layer gate:
 * instance + connection + this React tree). It is NOT live state.
 */
function ChatPanelView({
  state,
  rpc,
}: {
  state: {
    channel: string;
    who: string;
    messages: ChatMessage[];
    loads: number;
    agentReply: string;
    replying: boolean;
  };
  // biome-ignore lint/suspicious/noExplicitAny: the slot's rpc facade shape is exact but erased here
  rpc: any;
  keyOf: (id: string) => string;
}): ReactElement {
  const [draft, setDraft] = useState("");
  return (
    <section data-testid="chat-panel">
      <h2>chat · {state.channel}</h2>
      <p data-testid="chat-who">you are {state.who}</p>
      <p data-testid="chat-loads">loads: {state.loads}</p>
      <ul data-testid="chat-messages">
        {state.messages.map((m) => (
          <li key={m.id} data-from={m.from}>
            <b>{m.from}:</b> {m.text}
          </li>
        ))}
      </ul>
      {state.agentReply && <p data-testid="chat-agent">{state.agentReply}</p>}
      <form
        data-testid="chat-form"
        onSubmit={(e) => {
          e.preventDefault();
          const text = draft.trim();
          if (text) void rpc.send({ text });
          setDraft("");
        }}
      >
        <input
          name="draft"
          data-testid="chat-draft"
          placeholder="Message lobby"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
        />
        <button type="submit">Send</button>
      </form>
      <button type="button" data-testid="chat-agent-btn" onClick={() => void rpc.agent({})}>
        Ask agent
      </button>
    </section>
  );
}
