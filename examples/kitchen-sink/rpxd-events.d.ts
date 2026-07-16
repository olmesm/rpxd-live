/**
 * Typed broadcasts (§8) — the manual, userland events map.
 *
 * Augment `@rpxd/core`'s `Register` with an `events` interface keyed by event
 * name → payload shape. Once merged, `ctx.broadcast(topic, event, payload)` and
 * `.on(event, handler)` autocomplete the event name and type-check the payload
 * across the whole app. There is no codegen for this — the map is maintained by
 * hand, and any event you don't register keeps the permissive `unknown` payload.
 *
 * Keep this file in your `tsconfig` `include` so the augmentation is picked up.
 */

import type { Message } from "./routes/chat.tsx";
import type { ChatMessage, PanelNotice } from "./slots/chat-panel.tsx";

declare module "@rpxd/core" {
  interface Register {
    events: {
      "message.created": Message;
      // Dashboard chat slot (ADR 0002 item 16): multiplayer messages and the
      // cross-object notice a page broadcasts onto the chat channel.
      "panel.message": ChatMessage;
      "panel.notice": PanelNotice;
    };
  }
}
