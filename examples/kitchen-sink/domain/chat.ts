/**
 * Chat domain module — the service-layer boundary for the dashboard chat slot.
 *
 * `slots/chat-panel.tsx` calls these functions; the slot never touches a data
 * layer directly (same rule pages follow, see the app-structure guide). The
 * store is a per-channel in-memory log — deliberately trivial so the e2e stays
 * deterministic; a real app would persist through Prisma like `domain/todos.ts`.
 */

/** One chat line. `from` is the sender's email (or "guest"); `id` is server-assigned. */
export interface ChatMessage {
  id: string;
  text: string;
  from: string;
}

/** A cross-object notice broadcast onto a channel by another live object (a page). */
export interface PanelNotice {
  text: string;
}

const log = new Map<string, ChatMessage[]>();
let seq = 0;

/** The channel's message history (a copy — callers must not mutate the store). */
export async function chatHistory(channel: string): Promise<ChatMessage[]> {
  return [...(log.get(channel) ?? [])];
}

/** Append a message to a channel; returns the persisted row with its server id. */
export async function appendChatMessage(
  channel: string,
  msg: { text: string; from: string },
): Promise<ChatMessage> {
  const row: ChatMessage = { id: `msg-${++seq}`, text: msg.text, from: msg.from };
  const arr = log.get(channel) ?? [];
  arr.push(row);
  log.set(channel, arr);
  return row;
}
