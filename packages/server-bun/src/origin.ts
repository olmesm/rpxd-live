/**
 * Origin policy for the rpxd control plane (#52): `/__rpxd/ws|stream|rpc|control`
 * carry ambient credentials, and the same-origin policy does **not** apply to
 * WebSocket handshakes — so without an Origin check a malicious page can open
 * an authenticated duplex socket (cross-site WebSocket hijacking) or fire a
 * blind cross-site POST. The default is same-origin; a deliberate cross-origin
 * deployment opts in via {@link AllowedOrigins}.
 *
 * SSR `GET` navigation and `route()` handlers are intentionally **not** gated —
 * a top-level navigation is legitimately cross-site (an inbound link).
 */

/**
 * Cross-origin allowlist for the control plane. A string array is matched
 * exactly against the `Origin` header (same-origin is always allowed on top);
 * `"*"` explicitly opts back into the pre-#52 any-origin behavior. A predicate
 * takes the raw `Origin` string for wildcard-subdomain / proxy setups.
 *
 * @example
 * ```ts
 * const allow: AllowedOrigins = ["https://app.example.com"];
 * const anySub: AllowedOrigins = (o) => new URL(o).hostname.endsWith(".example.com");
 * ```
 */
export type AllowedOrigins = readonly string[] | ((origin: string) => boolean);

function hostOf(url: string): string | null {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Decide whether a request may reach the control plane.
 *
 * - **Absent `Origin`** → allowed. Cross-site WebSocket hijacking is a
 *   browser-only attack; native clients, server-to-server calls, CLIs and the
 *   test harness send no `Origin` and are not the threat.
 * - **`Origin` authority matches the target `Host`** → allowed (same-origin —
 *   every normal browser app, no behavior change).
 * - Otherwise the {@link AllowedOrigins} policy decides; the default (`undefined`)
 *   rejects.
 *
 * Same-origin compares the `Origin`'s host against the `Host` header (falling
 * back to the request URL's host). It is host-based, not scheme-based: behind a
 * TLS-terminating proxy the server sees `http`, so a strict scheme compare would
 * be unreliable — use the {@link AllowedOrigins} predicate form when you need
 * scheme/proxy-aware matching.
 *
 * @example
 * ```ts
 * originAllowed(req);                                   // same-origin only
 * originAllowed(req, ["https://admin.example.com"]);    // + one extra origin
 * originAllowed(req, (o) => o.endsWith(".example.com")); // wildcard subdomains
 * ```
 */
export function originAllowed(req: Request, allowed?: AllowedOrigins): boolean {
  const origin = req.headers.get("origin");
  if (origin === null) return true;

  if (typeof allowed === "function") return allowed(origin);

  const host = req.headers.get("host") ?? hostOf(req.url);
  if (host && hostOf(origin) === host.toLowerCase()) return true;

  if (allowed) {
    if (allowed.includes("*")) return true;
    return allowed.includes(origin);
  }
  return false;
}
