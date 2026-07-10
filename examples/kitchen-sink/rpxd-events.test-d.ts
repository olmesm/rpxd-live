/**
 * Type-level acceptance for the app's typed broadcasts (§8). Enforced by
 * `tsc -p tsconfig.json` (`bun run typecheck`) — this file is compiled, never
 * executed. It proves the `Register["events"]` augmentation in
 * `rpxd-events.d.ts` actually narrows the shared `broadcast`/`.on` types.
 */
import type { EventName, EventPayload } from "@rpxd/core";
import type { Message } from "./routes/chat.tsx";

// A registered event's payload resolves to its declared shape…
type RegisteredPayload = EventPayload<"message.created">;
const _registered: RegisteredPayload = { id: "m-1", text: "hi" } satisfies Message;
void _registered;

// @ts-expect-error — a registered payload rejects the wrong shape.
const _wrong: EventPayload<"message.created"> = { id: "m-1", body: "hi" };
void _wrong;

// …while an unregistered event resolves to exactly `unknown` (strict by
// default) — not `any`, so the payload can't be used without narrowing.
type IsAny<T> = 0 extends 1 & T ? true : false;
type IsUnknown<T> = IsAny<T> extends true ? false : unknown extends T ? true : false;
const _unregistered: IsUnknown<EventPayload<"never.registered">> = true;
void _unregistered;

// The registered event name is offered for autocomplete on the open `EventName`.
const _name: EventName = "message.created";
void _name;
