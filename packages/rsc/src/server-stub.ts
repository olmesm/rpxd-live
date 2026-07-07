/**
 * Non-react-server resolution of `@rpxd/rsc` (§16): the package's `.` export
 * is conditional — only the react-server graph gets the Flight serializer.
 * Everywhere else (ssr/client bundles, plain Node/Bun) `rsc()` throws with a
 * pointer, and the bundles never touch the Flight runtime's build virtuals.
 */
import type { ReactElement } from "react";
import type { RscField } from "./shared.ts";

export { isRscField, type RscField } from "./shared.ts";

/**
 * Flight-serialize a component subtree (§16) — react-server graph only.
 * This stub is what every other environment resolves; calling it means the
 * handler is not running under `rsc: true`.
 *
 * @example
 * ```tsx
 * const body = await rsc(<Markdown source={doc.raw} />); // needs rsc: true
 * ```
 */
export async function rsc(_element: ReactElement): Promise<RscField> {
  throw new Error(
    "rsc() needs the Flight runtime — set `rsc: true` in rpxd.config.ts so " +
      "handlers run inside the react-server environment (§16)",
  );
}
