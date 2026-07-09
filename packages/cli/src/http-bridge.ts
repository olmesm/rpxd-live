/**
 * node:http ↔ web `Request` bridging helpers shared by the dev server.
 */

/**
 * Build the absolute request URL for a node request, or `null` when the request
 * line / `Host` header is malformed enough that URL parsing throws. Callers
 * answer 400 instead of letting a synchronous `TypeError` escape the `request`
 * / `upgrade` event handler and crash the process.
 *
 * @example
 * ```ts
 * nodeRequestUrl({ headers: { host: "localhost:3000" }, url: "/x" }); // "http://localhost:3000/x"
 * nodeRequestUrl({ headers: { host: "bad host" }, url: "/" });        // null
 * ```
 */
export function nodeRequestUrl(req: { headers: { host?: string }; url?: string }): string | null {
  try {
    return new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`).href;
  } catch {
    return null;
  }
}
