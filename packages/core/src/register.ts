/**
 * Registered-route typing (§7): derived from the {@link Register} merge
 * target, which lives in `index.ts` — module augmentation only merges with
 * interfaces declared (not re-exported) in the augmented module.
 */
import type { Register } from "./index.ts";

type Routes = Register extends { routes: infer R } ? R : Record<string, never>;

/** All registered route paths — falls back to `string` before codegen runs. */
export type RegisteredPath = [keyof Routes] extends [never] ? string : keyof Routes & string;

/**
 * The target for {@link redirect} (§10): autocompletes {@link RegisteredPath}
 * while still accepting any string. Unlike `Link`/`nav` — which take a path
 * *pattern* plus typed `params` and build the href — a redirect target is a
 * *final URL*. It may be dynamic (a value echoed back from the server), carry a
 * query string, substitute `$param` segments, or point at a non-page path like
 * `/403`, so it can't be locked to the pattern union.
 */
export type RedirectTarget = RegisteredPath | (string & {});

type Events = Register extends { events: infer E } ? E : Record<string, unknown>;

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
 * {@link Register}'s `events` map, or `unknown` for an event that isn't
 * registered. `unknown` (not `any`) is deliberate: it nudges you to register the
 * event, since an unregistered payload can't be used without a narrowing check.
 */
export type EventPayload<K extends string> = K extends keyof Events ? Events[K] : unknown;
