/**
 * Marker shape for RSC fields (§16): an opaque serialized subtree in state.
 *
 * `$rsc` is a **reserved key**. Only `rsc()` (`packages/rsc/src/server.ts`)
 * should ever produce a value of this shape. Since #95, genuine `rsc()`
 * output is HMAC-branded: `$rscTag` is `HMAC-SHA256(payload,
 * RPXD_SESSION_SECRET)` (hex), stamped server-side when a secret is
 * configured. Verification is **SSR-only** — the SSR deserializer
 * (`packages/cli/src/ssr.ts`) checks `$rscTag` before handing the payload to
 * `createFromReadableStream`, so a forged/tampered `{ $rsc }` value placed in
 * state can't be Flight-deserialized there. The browser never verifies: it
 * has no server secret to check against, and doesn't need one — an RSC field
 * only ever reaches the browser over the authenticated, IDOR-protected
 * server→client stream (SSE/WS), not from anything the browser could inject
 * into state itself. The check below ({@link isRscField}) stays purely
 * structural regardless — `$rscTag` is optional and unchecked by it, since
 * verifying is the SSR deserializer's job, not this predicate's.
 */
export interface RscField {
  /** Serialized server-rendered subtree. Opaque — never touch it in reducers. */
  $rsc: string;
  /**
   * HMAC-SHA256(payload, RPXD_SESSION_SECRET) hex digest, stamped by `rsc()`
   * when a secret is configured (#95, SSR-only brand). Verified by the SSR
   * deserializer only — the browser trusts the field unconditionally (see
   * {@link RscField}). Absent when `rsc()` ran with no secret configured
   * (`cookie.sign:false`, or no secret at all — back-compat, never throws).
   */
  $rscTag?: string;
}

/**
 * True when a state value is an RSC field marker.
 *
 * This check is **structural only** — it does not verify `$rscTag` (see
 * {@link RscField}). `$rsc` is a reserved key: app code must never place
 * user-controlled data into state in this shape, since anything matching
 * `{ $rsc: string }` is recognized as an RSC field marker and routed to the
 * Flight deserializer (SSR verifies the brand first; the browser trusts the
 * authenticated stream it arrived over).
 *
 * @example
 * ```ts
 * isRscField({ $rsc: "<p>hi</p>" }); // true
 * isRscField("plain string");        // false
 * ```
 */
export function isRscField(value: unknown): value is RscField {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { $rsc?: unknown }).$rsc === "string"
  );
}

/**
 * Read a byte stream to a UTF-8 string, flushing the decoder at the end. The
 * final `decoder.decode()` is required: bytes buffered from a multi-byte
 * character that lands at the very end of the stream would otherwise be
 * silently dropped, truncating the payload.
 *
 * @example
 * ```ts
 * const text = await decodeStream(renderToReadableStream(el).getReader());
 * ```
 */
export async function decodeStream(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<string> {
  const decoder = new TextDecoder();
  let out = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    out += decoder.decode(value, { stream: true });
  }
  out += decoder.decode(); // flush trailing bytes buffered across a chunk boundary
  return out;
}
