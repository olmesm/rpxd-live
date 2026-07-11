/**
 * Pure, total validation of an inbound rpc batch (channel pipeline,
 * increment 1). Replaces the unchecked `as RpcBatch` cast at the transport
 * boundary: `decodeBatch` never throws for any input, so a boundary can call
 * it on raw wire data (parsed JSON, or worse) without a try/catch.
 *
 * `decodeBatch` only guarantees the batch is STRUCTURALLY safe to hand to
 * {@link LiveInstance.handleBatch | `LiveInstance.handleBatch`} without a
 * crash — it deliberately does not check `v` (the protocol version): version
 * gating stays in `handleBatch`, which already error-acks a `ProtocolError`
 * and is pinned by the protocol-conformance tests. Wiring this into the
 * server-bun boundary is increment 2 of this feature.
 *
 * @packageDocumentation
 */
import type { RpcBatch, RpcCall } from "./protocol.ts";

/**
 * `decodeBatch` failed to recognize `raw` as a well-formed {@link RpcBatch}.
 * `rpcId`/`instance` are carried only when they were themselves valid
 * strings on `raw` — enough to let a boundary report an un-ackable failure
 * (e.g. attribute it to the right instance) without ever trusting a
 * feature of `raw` it hasn't verified.
 *
 * @example
 * ```ts
 * import type { BatchDecodeError } from "@rpxd/core";
 * const err: BatchDecodeError = { ok: false, reason: "calls-not-array", rpcId: "r1", instance: "i1" };
 * ```
 */
export type BatchDecodeError = {
  ok: false;
  reason: string;
  rpcId?: string;
  instance?: string;
};

/**
 * `decodeBatch` recognized `raw` as a structurally well-formed
 * {@link RpcBatch} — safe to pass to `LiveInstance.handleBatch`.
 *
 * @example
 * ```ts
 * import type { DecodedBatch } from "@rpxd/core";
 * const ok: DecodedBatch = { ok: true, batch: { v: 1, instance: "i", rpcId: "r", calls: [] } };
 * ```
 */
export type DecodedBatch = { ok: true; batch: RpcBatch };

/** True for a value that is `{ rpc: string, payload: <present> }`. */
function isWellFormedCall(call: unknown): call is RpcCall {
  if (typeof call !== "object" || call === null) return false;
  if (typeof (call as { rpc?: unknown }).rpc !== "string") return false;
  // "present" means the key exists on the object — an explicit `payload:
  // undefined` still counts; only a missing key doesn't.
  return "payload" in call;
}

/**
 * Validate `raw` as a wire {@link RpcBatch} without ever throwing. Deliberately
 * does NOT check `v` (the protocol version) — that gate stays in
 * `LiveInstance.handleBatch` so a version mismatch still produces its own
 * `ProtocolError` ack. This function only guarantees `raw.calls` is an array
 * of `{ rpc, payload }` shapes, so a caller (e.g. `calls: null` off the wire)
 * can never crash `handleBatch`'s `batch.calls.length` read.
 *
 * @example
 * ```ts
 * import { decodeBatch } from "@rpxd/core";
 *
 * const result = decodeBatch(JSON.parse(rawBody));
 * if (!result.ok) {
 *   console.error(`bad batch: ${result.reason}`, result.rpcId, result.instance);
 * } else {
 *   await instance.handleBatch(result.batch);
 * }
 * ```
 */
export function decodeBatch(raw: unknown): DecodedBatch | BatchDecodeError {
  if (typeof raw !== "object" || raw === null) {
    return { ok: false, reason: "not-an-object" };
  }
  const candidate = raw as { instance?: unknown; rpcId?: unknown; calls?: unknown };

  if (typeof candidate.instance !== "string") {
    return { ok: false, reason: "instance-not-string" };
  }
  const instance = candidate.instance;

  if (typeof candidate.rpcId !== "string") {
    return { ok: false, reason: "rpcId-not-string", instance };
  }
  const rpcId = candidate.rpcId;

  if (!Array.isArray(candidate.calls)) {
    return { ok: false, reason: "calls-not-array", rpcId, instance };
  }
  for (const call of candidate.calls) {
    if (!isWellFormedCall(call)) {
      return { ok: false, reason: "calls-malformed", rpcId, instance };
    }
  }

  return { ok: true, batch: raw as RpcBatch };
}
