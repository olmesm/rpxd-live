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
 * Cold / same-route / slot mount (§7, ADR 0002 item 6): match `path` against the
 * union of routed pages and mount-only slots, run guard→setup→load. An optional
 * `stream` id joins the fresh instance to an already-open transport (tier-2 soft
 * reload); `mountId` correlates a WS mount that denies before binding (#65).
 *
 * A page's URL query IS its props record, so the mounted payload is `props`
 * (ADR 0002 item 6, unifying the vocabulary with the {@link UrlControl} message).
 * Unlike the URL query codec, control-plane `props` is already a JSON value model
 * — the values arrive typed, not as raw strings — and is validated against the
 * matched registration's props schema (when declared) **before** `guard`.
 */
export interface MountControl {
  type: "mount";
  path: string;
  props: Record<string, unknown>;
  stream?: string;
  mountId?: string;
  /**
   * SSR attach token (ADR 0003): instances are stream-scoped, so a mount from
   * a stream that hasn't connected yet can present the bootstrap's token to
   * CLAIM the SSR-born instance of the same identity instead of building a
   * twin — making page↔slot sharing order-free across connect/mount races.
   */
  attach?: string;
}

/**
 * Props patch (§7): reconcile a live instance to a new URL — `guard` then `load`,
 * no `setup`, state preserved. A page's URL query is its props record, so the
 * patched payload is `props` (ADR 0002 item 1); a deny comes back as a
 * `{ redirect }` control response (SSE) or a `redirect` envelope (WS).
 *
 * Like {@link MountControl}, `props` is a JSON value model — the values arrive
 * already typed off the control plane, not as raw query strings (ADR 0002 item
 * 7) — and is validated against the instance's registration props schema (when
 * declared) **before** `guard`+`load`. An invalid record is a `422` (SSE control
 * response) or an instance-scoped `error` envelope (WS), and no reconcile runs.
 */
export interface UrlControl {
  type: "url";
  instance: string;
  props: Record<string, unknown>;
}

/** Same-route forward nav (§7): abandon an instance so it evicts off its stream. */
export interface ReleaseControl {
  type: "release";
  instance: string;
  stream: string;
}

/**
 * Batched mount (ADR 0002 item 11): coalesce N same-tick slot mounts into ONE
 * control POST. Each `mounts[i]` is one {@link MountControl}'s `{ path, props }`
 * pair; the optional `stream` id joins every successful mount to that already-open
 * transport, exactly as {@link MountControl.stream} does for a single mount. The
 * server runs the identical single-mount path per entry (validate props → mount
 * → join) and answers with a **positional** {@link MountBatchResponse} — one
 * result per entry, in order. One entry's failure never poisons its siblings.
 *
 * A single same-tick `mountSlot` stays an unbatched {@link MountControl} (a
 * one-entry batch is never emitted); this shape appears only for 2+ coalesced
 * mounts.
 *
 * @example
 * ```ts
 * const frame: MountBatchControl = {
 *   type: "mount-batch",
 *   stream: "s-1",
 *   mounts: [
 *     { path: "/card/1", props: {} },
 *     { path: "/card/2", props: {} },
 *   ],
 * };
 * ```
 */
export interface MountBatchControl {
  type: "mount-batch";
  stream?: string;
  mounts: { path: string; props: Record<string, unknown> }[];
  /** SSR attach token, shared by every entry (see {@link MountControl.attach}). */
  attach?: string;
}

/**
 * One positional result of a {@link MountBatchControl} — it answers the entry at
 * the same index. Exactly one of: `{ instance, seq }` (mounted; the same fields a
 * single `mount` returns), `{ redirect }` (a `setup`/`guard` deny — the caller
 * throws `redirect()`), or `{ error }` (props validation / not-found / cap /
 * unexpected — the caller rejects). A failure here is scoped to this entry: its
 * siblings still resolve.
 */
export type MountBatchResult =
  | {
      instance: string;
      seq: number;
      path?: string;
      params?: Record<string, string>;
      /**
       * Adoption token for a cold mount with no live stream yet (ADR 0003):
       * instances are stream-scoped, so a stream connecting later presents this
       * as `?attach` to claim the instance (`LiveConnection.mount`).
       */
      attach?: string;
    }
  | { redirect: string }
  | { error: EnvelopeError };

/**
 * Response to a {@link MountBatchControl}: `results[i]` answers `mounts[i]`,
 * positionally (ADR 0002 item 11).
 */
export interface MountBatchResponse {
  results: MountBatchResult[];
}

/**
 * The upstream control-message union (the wire protocol guide, "Control
 * messages"). Reconciles a connection to navigation and gap recovery.
 */
export type Control =
  | ResyncControl
  | MountControl
  | MountBatchControl
  | UrlControl
  | ReleaseControl;
