/**
 * RSC fields — server half (§16, experimental, `rsc: true` config flag).
 *
 * `rsc(<Component />)` renders a subtree ON THE SERVER into an opaque state
 * value; heavy rendering deps never ship to the client. The field rides
 * patches/snapshots/storage as a plain string — transport, persistence, SSR
 * and reconnect are unchanged.
 *
 * v1 serializes with `renderToString` (static server markup). The Flight
 * serialization + `'use client'` islands via `@vitejs/plugin-rsc` land
 * behind the same API — the marker shape and constraints are stable.
 *
 * Constraints (§16): never optimistic; not for keystroke-frequency updates;
 * patches replace the whole field (no diffing) and React reconciles.
 */
import type { ReactElement } from "react";
import { renderToString } from "react-dom/server";
import type { RscField } from "./shared.ts";

export { isRscField, type RscField } from "./shared.ts";

/**
 * Render a component subtree into an opaque state field (§16).
 *
 * @example
 * ```tsx
 * mount: async ({ slug }) => {
 *   const doc = await db.doc.find(slug);
 *   return { doc, body: rsc(<Markdown source={doc.raw} />) };
 * },
 * ```
 */
export function rsc(element: ReactElement): RscField {
  return { $rsc: renderToString(element) };
}
