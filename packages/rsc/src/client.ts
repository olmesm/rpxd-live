/**
 * RSC fields — client half (§16): swap marked state fields for renderable
 * elements at snapshot time, so `{state.body}` renders the server-rendered
 * subtree. Elements are memoized per payload → React reconciles cheaply and
 * unchanged branches keep referential identity (§2 structural sharing).
 */
import { createElement, type ReactElement } from "react";
import { isRscField } from "./shared.ts";

export { isRscField, type RscField } from "./shared.ts";

const CACHE_LIMIT = 256;
const elementCache = new Map<string, ReactElement>();

function elementFor(html: string): ReactElement {
  const cached = elementCache.get(html);
  if (cached) return cached;
  // display:contents keeps the wrapper layout-neutral; the payload is
  // server-produced markup, not user input.
  const element = createElement("div", {
    style: { display: "contents" },
    "data-rpxd-rsc": true,
    // biome-ignore lint/security/noDangerouslySetInnerHtml: payload is server-rendered by rsc(), never user input
    dangerouslySetInnerHTML: { __html: html },
  });
  if (elementCache.size >= CACHE_LIMIT) {
    const oldest = elementCache.keys().next().value;
    if (oldest !== undefined) elementCache.delete(oldest);
  }
  elementCache.set(html, element);
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
