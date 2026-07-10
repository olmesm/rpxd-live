/**
 * Registered-route typing (§7): derived from the {@link Register} merge
 * target, which lives in `index.ts` — module augmentation only merges with
 * interfaces declared (not re-exported) in the augmented module.
 */
import type { Register } from "./index.ts";

type Routes = Register extends { routes: infer R } ? R : Record<string, never>;

/** All registered route paths — falls back to `string` before codegen runs. */
export type RegisteredPath = [keyof Routes] extends [never] ? string : keyof Routes & string;

// biome-ignore lint/suspicious/noExplicitAny: the default map keeps unregistered events fully permissive (today's behavior) so existing `.on` handlers keep compiling
type Events = Register extends { events: infer E } ? E : Record<string, any>;

/**
 * All registered broadcast event names (§8) — the keys of the `events` map an
 * app merges into {@link Register}. Falls back to `string` until then, so an
 * un-augmented project keeps compiling. Used to autocomplete the `event` arg of
 * `ctx.broadcast` and `.on`.
 */
export type RegisteredEvent = keyof Events & string;

/**
 * The `event` argument type for `ctx.broadcast` and `.on`: autocompletes the
 * {@link RegisteredEvent} names while still accepting any string, so events can
 * be adopted incrementally without an all-or-nothing migration.
 */
export type EventName = RegisteredEvent | (string & {});

/**
 * Payload type for a broadcast event `K` (§8) — the shape registered for `K` in
 * {@link Register}'s `events` map, or `any` for an event that isn't registered
 * (unregistered events stay permissive, exactly as before events were typed).
 */
export type EventPayload<K extends string> = K extends keyof Events
  ? Events[K]
  : // biome-ignore lint/suspicious/noExplicitAny: an unregistered event is untyped — `any` keeps it permissive and preserves existing annotated handlers
    any;
