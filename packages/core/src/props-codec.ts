/**
 * The URL props codec (ADR 0002 §3) — the one place a page's `?query` string is
 * translated to and from its typed props record. A props value is a JSON value;
 * the URL is one of its two encodings (the control-plane JSON body is the
 * other). The codec is **per-value try-`JSON.parse`, else raw string** — the
 * TanStack Router precedent — so `?limit=20` reads as the number `20` while
 * `?filter=done` stays the string `"done"`, with no schema needed to tell them
 * apart. Applied by the mounter **only when a props schema is declared**;
 * schema-less routes keep the raw string record (back-compat).
 */

/**
 * Decode a URL query string into a props record: each value is `JSON.parse`d
 * when it can be, else kept as its raw string (parse-else-string). Repeated
 * keys are last-wins, matching the raw-query behavior a schema-less route sees.
 * The inverse of {@link encodeProps}.
 *
 * @example
 * ```ts
 * decodeProps(new URLSearchParams("limit=20&filter=done&ok=true"));
 * // { limit: 20, filter: "done", ok: true }
 * ```
 */
export function decodeProps(qs: URLSearchParams): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  qs.forEach((value, key) => {
    try {
      out[key] = JSON.parse(value);
    } catch {
      out[key] = value;
    }
  });
  return out;
}

/**
 * Encode a props record into a URL query string — the inverse of
 * {@link decodeProps}, chosen so `decodeProps(encodeProps(x))` deep-equals `x`.
 * Non-string JSON values are `JSON.stringify`d. A string is left **bare** when
 * it's URL-readable and unambiguous, but JSON-encoded (quoted) when its bare
 * form would `JSON.parse` into something else — `"20"`, `"true"`, `"null"`, or
 * any JSON-shaped string — so it round-trips back as the original string rather
 * than a number/boolean/object. `undefined` values are omitted (a URL can't
 * represent them). Returns a `URLSearchParams` so it composes with `buildHref`.
 *
 * @example
 * ```ts
 * encodeProps({ limit: 20, filter: "done", v: "20" }).toString();
 * // "limit=20&filter=done&v=%2220%22"  (v is quoted so it decodes as "20")
 * ```
 */
export function encodeProps(props: Record<string, unknown>): URLSearchParams {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined) continue;
    if (typeof value === "string") {
      qs.set(key, isJsonParseable(value) ? JSON.stringify(value) : value);
    } else {
      qs.set(key, JSON.stringify(value));
    }
  }
  return qs;
}

/**
 * Whether a raw string would be consumed by `JSON.parse` (i.e. {@link decodeProps}
 * would turn it into a non-string, or a *different* string when it's already
 * quoted). Such strings are ambiguous and must be quoted on the way out.
 */
function isJsonParseable(value: string): boolean {
  try {
    JSON.parse(value);
    return true;
  } catch {
    return false;
  }
}
