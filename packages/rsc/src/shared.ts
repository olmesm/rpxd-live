/**
 * Marker shape for RSC fields (§16): an opaque serialized subtree in state.
 *
 * `$rsc` is a **reserved key**. Only `rsc()` (`packages/rsc/src/server.ts`)
 * should ever produce a value of this shape. Never place user-controlled
 * data into state as `{ $rsc: string }` — the check below is purely
 * structural (see {@link isRscField}), so a coincidental or hostile object
 * with this shape is indistinguishable from a genuine Flight payload and
 * will be handed to the Flight deserializer on the client/SSR. A
 * non-forgeable brand for this marker is tracked as a follow-up (issue #95);
 * until then, this is an app-author invariant, not an enforced one.
 */
export interface RscField {
  /** Serialized server-rendered subtree. Opaque — never touch it in reducers. */
  $rsc: string;
}

/**
 * True when a state value is an RSC field marker.
 *
 * This check is **structural only** — it does not verify that the payload
 * was actually produced by `rsc()`. `$rsc` is a reserved key: app code must
 * never place user-controlled data into state in this shape, since anything
 * matching `{ $rsc: string }` is treated as a trusted Flight payload and
 * passed to `createFromReadableStream` (see {@link RscField}).
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
