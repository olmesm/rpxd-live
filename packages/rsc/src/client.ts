/**
 * RSC fields — deserializing half (§16): swap marked state fields for
 * renderable elements at snapshot time, so `{state.body}` renders the
 * Flight-serialized server subtree with its `'use client'` islands hydrated.
 *
 * This module is deserializer-agnostic: each environment injects its own
 * Flight runtime via {@link configureRscRuntime} (`@vitejs/plugin-rsc/ssr`
 * in the server graph, `/browser` in the client entry) — so neither runtime
 * ever leaks into the other bundle. Elements are memoized per payload →
 * React reconciles cheaply and unchanged branches keep referential identity
 * (§2 structural sharing).
 */
import { createElement, type ReactElement, Suspense, use } from "react";
import { isRscField, type RscField } from "./shared.ts";

export { isRscField, type RscField } from "./shared.ts";

/** Turns a Flight payload string back into a React subtree. */
export type RscDeserializer = (payload: string) => Promise<ReactElement>;

/**
 * SSR-only HMAC gate (§16, #95): `true` when a field's `$rscTag` checks out,
 * `false` to treat it as plain data instead of deserializing it. The browser
 * has no verifier configured (no server secret to check against) — see
 * {@link configureRscRuntime}.
 */
export type RscVerifier = (field: RscField) => boolean;

let deserializer: RscDeserializer | undefined;
let verifier: RscVerifier | undefined;

/**
 * Install the environment's Flight deserializer (§16). Called once by the
 * generated client entry (browser runtime) and by the SSR runtime (server
 * runtime) before anything renders RSC fields.
 *
 * `verify` is the SSR-only HMAC brand check (#95): the SSR runtime passes one
 * built from `process.env.RPXD_SESSION_SECRET` (`packages/cli/src/ssr.ts`);
 * the browser entry passes none — it has no server secret to verify against,
 * and doesn't need one (an RSC field only ever arrives over the
 * authenticated, IDOR-protected server→client stream). This module stays
 * crypto-free either way: the verifier is injected, never computed here.
 *
 * @example
 * ```ts
 * import { createFromReadableStream } from "@vitejs/plugin-rsc/browser";
 * configureRscRuntime((payload) => createFromReadableStream(flightStream(payload)));
 * ```
 */
export function configureRscRuntime(deserialize: RscDeserializer, verify?: RscVerifier): void {
  deserializer = deserialize;
  verifier = verify;
}

/**
 * Wrap a Flight payload string as the byte stream `createFromReadableStream`
 * consumes.
 *
 * @example
 * ```ts
 * const subtree = await createFromReadableStream(flightStream(field.$rsc));
 * ```
 */
export function flightStream(payload: string): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(payload));
      controller.close();
    },
  });
}

const CACHE_LIMIT = 64;
const elementCache = new Map<string, ReactElement>();
const payloadPromises = new Map<string, Promise<ReactElement>>();
// SSR-only verification memo (#95), folded into the same per-payload caching
// as the two maps above: `verified()` computes the HMAC check at most once
// per unique payload rather than once per `hydrateRscFields` call (which runs
// roughly once per render/snapshot).
const verifiedCache = new Map<string, boolean>();

function trim(cache: Map<string, unknown>): void {
  if (cache.size < CACHE_LIMIT) return;
  const oldest = cache.keys().next().value;
  if (oldest !== undefined) cache.delete(oldest);
}

/**
 * SSR-only HMAC gate (§16, #95), memoized per payload. No verifier installed
 * (the browser shape) → always `true`: the browser trusts the field because
 * it only ever arrives over the authenticated, IDOR-protected server→client
 * stream. A configured verifier that rejects the field logs once per payload
 * — there's no diagnostic-sink hook threaded through this deserializer-
 * agnostic module (browser has none to wire up; console mirrors how
 * `packages/client`'s browser-side code reports, per its own no-server-hook
 * exception).
 */
function verified(field: RscField): boolean {
  if (!verifier) return true;
  const cached = verifiedCache.get(field.$rsc);
  if (cached !== undefined) return cached;
  const ok = verifier(field);
  if (!ok) {
    console.warn(
      "[rpxd] RSC field failed HMAC verification (§16, #95) — treated as plain data, not deserialized",
    );
  }
  trim(verifiedCache);
  verifiedCache.set(field.$rsc, ok);
  return ok;
}

function promiseFor(field: RscField): Promise<ReactElement> {
  const payload = field.$rsc;
  const cached = payloadPromises.get(payload);
  if (cached) return cached;
  if (!deserializer) {
    throw new Error(
      "RSC field found but no Flight runtime installed — set `rsc: true` in " +
        "rpxd.config.ts (the framework calls configureRscRuntime for you, §16)",
    );
  }
  const promise = deserializer(payload);
  trim(payloadPromises);
  payloadPromises.set(payload, promise);
  return promise;
}

/** Suspends on the field's deserialization, then renders the subtree. */
function RscPayload({ field }: { field: RscField }): ReactElement {
  return use(promiseFor(field));
}

function elementFor(field: RscField): ReactElement {
  const payload = field.$rsc;
  const cached = elementCache.get(payload);
  if (cached) return cached;
  // Suspense boundary: SSR streams through it (allReady waits); hydration
  // keeps the server HTML until the payload resolves, then attaches.
  const element = createElement(Suspense, { fallback: null }, createElement(RscPayload, { field }));
  trim(elementCache);
  elementCache.set(payload, element);
  return element;
}

/**
 * Deep-replace RSC field markers with renderable elements. Branches without
 * markers are returned by reference — memoized children stay memoized. A
 * field that fails SSR-only HMAC verification (#95) is left as its original,
 * un-deserialized value — never routed to `elementFor` — so the tree renders
 * it as plain data instead of a trusted Flight subtree.
 *
 * @example
 * ```ts
 * const state = hydrateRscFields(snapshot.state);
 * // <article>{state.body}</article> renders the server subtree
 * ```
 */
// biome-ignore lint/suspicious/noExplicitAny: state shape is app-defined; markers replaced in-place
export function hydrateRscFields<T>(value: T): any {
  if (isRscField(value)) return verified(value) ? elementFor(value) : value;
  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((item) => {
      const mapped = hydrateRscFields(item);
      if (mapped !== item) changed = true;
      return mapped;
    });
    return changed ? next : value;
  }
  if (typeof value === "object" && value !== null) {
    let changed = false;
    const next: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      const mapped = hydrateRscFields(item);
      if (mapped !== item) changed = true;
      next[key] = mapped;
    }
    return changed ? next : value;
  }
  return value;
}
