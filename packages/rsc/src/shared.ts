/** Marker shape for RSC fields (§16): an opaque serialized subtree in state. */
export interface RscField {
  /** Serialized server-rendered subtree. Opaque — never touch it in reducers. */
  $rsc: string;
}

/**
 * True when a state value is an RSC field marker.
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
