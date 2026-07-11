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
import { createHmac } from "node:crypto";
import type { ReactElement } from "react";
import { decodeStream, type RscField } from "./shared.ts";

export { isRscField, type RscField } from "./shared.ts";

/**
 * Sign a Flight payload with the SSR-only HMAC brand (§16, #95). `rsc()`
 * calls this after Flight-serializing; it's exported separately so the
 * signing logic is unit-testable without the react-server graph (this file's
 * `import("@vitejs/plugin-rsc/rsc")` only resolves there — see `rsc()` below).
 *
 * `node:crypto` is deliberately inline here (not in `shared.ts`/`client.ts`,
 * which are browser-imported and must stay crypto-free). The algorithm MUST
 * match the SSR verifier built in `packages/cli/src/ssr.ts`
 * (`makeRscVerifier`) byte for byte: HMAC-SHA256, hex digest, over the raw
 * payload string, both reading `process.env.RPXD_SESSION_SECRET` — the only
 * channel shared between the react-server graph (this file) and the ssr graph
 * (the verifier), which are separate module graphs in the same process.
 *
 * Best-effort on secret presence: no secret configured → the field ships
 * unsigned (`cookie.sign:false`, or no secret at all). This never throws —
 * `rsc()` must stay safe to call regardless of session-secret configuration
 * (§3/§8: handlers never block on it, and a missing secret is a deliberate,
 * documented back-compat mode, not a caller error).
 *
 * @example
 * ```ts
 * process.env.RPXD_SESSION_SECRET = "…";
 * signRscField("<p>hi</p>"); // { $rsc: "<p>hi</p>", $rscTag: "…hex…" }
 * ```
 */
export function signRscField(payload: string): RscField {
  const secret = process.env.RPXD_SESSION_SECRET;
  if (!secret) return { $rsc: payload }; // unsigned — no secret configured (back-compat)
  const $rscTag = createHmac("sha256", secret).update(payload).digest("hex");
  return { $rsc: payload, $rscTag };
}

/**
 * Flight-serialize a component subtree into an opaque state field (§16).
 * Serialize before `ctx.patchState` — mutators are sync by design (§3).
 *
 * The returned `{ $rsc: string }` shape is a reserved, HMAC-branded marker
 * (see {@link RscField}, #95): `rsc()` is the only sanctioned producer of it.
 * Never construct or merge this shape from user-controlled data — the SSR
 * deserializer verifies the brand before trusting a field, but a value that
 * never passed through `rsc()` at all (and so was never branded) can't be
 * distinguished from one with no secret configured (both ship untagged).
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
  const payload = await decodeStream(renderToReadableStream(element).getReader());
  return signRscField(payload);
}
