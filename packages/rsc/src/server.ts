/**
 * RSC fields — server half (§16, `rsc: true` config flag).
 *
 * `rsc(<Component />)` Flight-serializes a subtree ON THE SERVER into an
 * opaque state value; heavy rendering deps never ship to the client, while
 * `'use client'` islands inside the subtree ride as module references and
 * hydrate interactive. The field is a plain string on patches/snapshots/
 * storage — transport, persistence, SSR and reconnect are unchanged.
 *
 * Requires the Flight runtime: with `rsc: true`, handlers run inside the
 * react-server Vite environment (§16); calling this without it throws.
 *
 * Constraints (§16): never optimistic; not for keystroke-frequency updates;
 * patches replace the whole field (no diffing) and React reconciles.
 */
import type { ReactElement } from "react";
import type { RscField } from "./shared.ts";

export { isRscField, type RscField } from "./shared.ts";

/**
 * Flight-serialize a component subtree into an opaque state field (§16).
 * Serialize before `ctx.patchState` — mutators are sync by design (§3).
 *
 * @example
 * ```tsx
 * const body = await rsc(<Markdown source={doc.raw} />);
 * ctx.patchState((s) => {
 *   s.body = body;
 * });
 * ```
 */
export async function rsc(element: ReactElement): Promise<RscField> {
  // This module only resolves under the react-server condition (see the
  // package's conditional exports) — every other graph gets server-stub.ts,
  // so the Flight runtime and its build virtuals stay out of their bundles.
  const { renderToReadableStream } = await import("@vitejs/plugin-rsc/rsc");
  const reader = renderToReadableStream(element).getReader();
  const decoder = new TextDecoder();
  let payload = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    payload += decoder.decode(value, { stream: true });
  }
  return { $rsc: payload };
}
