/**
 * Wire protocol types — the normative definition lives in the wire protocol guide.
 * Everything here is transport-agnostic: SSE and WS carry the same shapes.
 *
 * @packageDocumentation
 */

/**
 * Version of the rpxd wire protocol (the `{ seq, patches | full, ... }`
 * envelope). Bumped only on breaking envelope changes; client and server must
 * agree on this value to speak to each other.
 *
 * @example
 * ```ts
 * import { PROTOCOL_VERSION } from "@rpxd/core";
 * console.log(PROTOCOL_VERSION); // 1
 * ```
 */
export const PROTOCOL_VERSION = 1;

// WIRE CONTRACT — the Envelope / Patch / RpcBatch shapes below are documented in
// docs-site/src/content/docs/concepts/wire-protocol.md and pinned by
// packages/core/test/protocol-conformance.test.ts. Change all three together.

/**
 * A single state mutation, as produced by Immer's `produceWithPatches`.
 * Paths starting with `"$session"` target the session slice instead of page
 * state.
 *
 * `append` is an rpxd extension (§2): concatenate the string `value` onto the
 * string at `path` — string-suffix growth ships only the delta, so LLM/token
 * streams are O(delta) on the wire. A non-string target is a protocol error;
 * the client discards the envelope and requests a full resync.
 */
export interface Patch {
  op: "replace" | "add" | "remove" | "append";
  path: (string | number)[];
  value?: unknown;
}

/**
 * One downstream message. Exactly one of `patches` or `full` is present.
 * See the wire protocol guide for ordering and recovery rules.
 */
export interface Envelope {
  /** Per-instance, monotonically increasing; +1 per envelope. */
  seq: number;
  /** Instance the envelope belongs to. */
  instance: string;
  /** Immer patches to apply to confirmed state. */
  patches?: Patch[];
  /** Full snapshot: `{ state, session }` — recovery and initial attach. */
  full?: { state: unknown; session: unknown };
  /** Present when this envelope acks an rpc batch. */
  rpcId?: string;
  /** tempId → realId links declared server-side via `ctx.resolveId` (§4 escape hatch). */
  idMap?: Record<string, string>;
  /** Present when the acked rpc batch failed. */
  error?: EnvelopeError;
  /** Runtime redirect target (§10): a `guard`/`load` deny during a URL change — client soft-navs. */
  redirect?: string;
  /**
   * Echo of the WS `mount` frame's correlation id (#65): a denied socket mount
   * has no bound instance to address (`instance: ""`), so the client matches
   * the redirect/error outcome to its in-flight mount by this id instead.
   */
  mountId?: string;
}

/** Error surface of a failed rpc batch — feeds `sync.errors` on the client. */
export interface EnvelopeError {
  name: string;
  message: string;
  /** The rpc name that threw, when attributable. */
  rpc?: string;
}

/** One rpc invocation inside a batch. */
export interface RpcCall {
  rpc: string;
  payload: unknown;
}

/** Upstream rpc batch — same-tick calls coalesced client-side (§6). */
export interface RpcBatch {
  v: typeof PROTOCOL_VERSION;
  instance: string;
  /** Client-generated id; the server dedupes resends on it. */
  rpcId: string;
  calls: RpcCall[];
}

// WIRE CONTRACT — the control messages below reconcile a connection to
// navigation and gap recovery (docs-site/.../wire-protocol.md "Control
// messages"). None carry `v`. The `url` message's payload record is `props`
// (ADR 0002 item 1): a page's URL query IS its props record.

/** Gap recovery / late attach (§2): the server answers with a `full` at the current seq. */
export interface ResyncControl {
  type: "resync";
  instance: string;
}

/**
 * Cold / same-route mount (§7): match `path`, run guard→setup→load. An optional
 * `stream` id joins the fresh instance to an already-open transport (tier-2 soft
 * reload); `mountId` correlates a WS mount that denies before binding (#65).
 */
export interface MountControl {
  type: "mount";
  path: string;
  search: Record<string, string>;
  stream?: string;
  mountId?: string;
}

/**
 * Props patch (§7): reconcile a live instance to a new URL — `guard` then `load`,
 * no `setup`, state preserved. A page's URL query is its props record, so the
 * patched payload is `props` (ADR 0002 item 1); a deny comes back as a
 * `{ redirect }` control response (SSE) or a `redirect` envelope (WS).
 */
export interface UrlControl {
  type: "url";
  instance: string;
  props: Record<string, string>;
}

/** Same-route forward nav (§7): abandon an instance so it evicts off its stream. */
export interface ReleaseControl {
  type: "release";
  instance: string;
  stream: string;
}

/**
 * The upstream control-message union (the wire protocol guide, "Control
 * messages"). Reconciles a connection to navigation and gap recovery.
 */
export type Control = ResyncControl | MountControl | UrlControl | ReleaseControl;
