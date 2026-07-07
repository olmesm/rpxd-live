/**
 * RSC fields — deserializing half (§16 step 2): swap marked state fields for
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
import { isRscField } from "./shared.ts";

export { isRscField, type RscField } from "./shared.ts";

/** Turns a Flight payload string back into a React subtree. */
export type RscDeserializer = (payload: string) => Promise<ReactElement>;

let deserializer: RscDeserializer | undefined;

/**
 * Install the environment's Flight deserializer (§16). Called once by the
 * generated client entry (browser runtime) and by the SSR runtime (server
 * runtime) before anything renders RSC fields.
 *
 * @example
 * ```ts
 * import { createFromReadableStream } from "@vitejs/plugin-rsc/browser";
 * configureRscRuntime((payload) => createFromReadableStream(flightStream(payload)));
 * ```
 */
export function configureRscRuntime(deserialize: RscDeserializer): void {
  deserializer = deserialize;
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

function trim(cache: Map<string, unknown>): void {
  if (cache.size < CACHE_LIMIT) return;
  const oldest = cache.keys().next().value;
  if (oldest !== undefined) cache.delete(oldest);
}

function promiseFor(payload: string): Promise<ReactElement> {
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

/** Suspends on the payload's deserialization, then renders the subtree. */
function RscPayload({ payload }: { payload: string }): ReactElement {
  return use(promiseFor(payload));
}

function elementFor(payload: string): ReactElement {
  const cached = elementCache.get(payload);
  if (cached) return cached;
  // Suspense boundary: SSR streams through it (allReady waits); hydration
  // keeps the server HTML until the payload resolves, then attaches.
  const element = createElement(
    Suspense,
    { fallback: null },
    createElement(RscPayload, { payload }),
  );
  trim(elementCache);
  elementCache.set(payload, element);
  return element;
}

/**
 * Deep-replace RSC field markers with renderable elements. Branches without
 * markers are returned by reference — memoized children stay memoized.
 *
 * @example
 * ```ts
 * const state = hydrateRscFields(snapshot.state);
 * // <article>{state.body}</article> renders the server subtree
 * ```
 */
// biome-ignore lint/suspicious/noExplicitAny: state shape is app-defined; markers replaced in-place
export function hydrateRscFields<T>(value: T): any {
  if (isRscField(value)) return elementFor(value.$rsc);
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
