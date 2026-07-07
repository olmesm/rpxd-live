/**
 * rpxd core runtime.
 *
 * Hosts the live-object runtime: the per-instance FIFO queue, Immer patch
 * production, the wire protocol types, storage adapters, and pubsub.
 *
 * @packageDocumentation
 */

/**
 * Version of the rpxd wire protocol (the `{ seq, patches | full, ... }`
 * envelope). Bumped only on breaking envelope changes; a client and server
 * must agree on this value to speak to each other.
 *
 * @example
 * ```ts
 * import { PROTOCOL_VERSION } from "@rpxd/core";
 * console.log(PROTOCOL_VERSION); // 1
 * ```
 */
export const PROTOCOL_VERSION = 1;
