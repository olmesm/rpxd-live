/**
 * Session-cookie helpers (B2) — the one place the `rpxd_sid` cookie is parsed,
 * verified, and signed, shared by the HTTP handler and the WS transport so both
 * resolve a request to the same session id.
 *
 * When a `secret` is configured the sid is **HMAC-signed** (`<sid>.<mac>`) and
 * verified on read: a forged or unsigned value fails verification and is treated
 * as a brand-new session, which closes session fixation and the `${sid}:${path}`
 * storage-namespace collision (an attacker can't present a chosen sid). Signing
 * needs no TLS — it's integrity, not confidentiality (pair with the `Secure`
 * cookie, B1, for the latter). With no secret the sid is used verbatim (the
 * pre-B2 behavior); {@link createRpxdHandler} warns once in that case.
 */
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

/** The session cookie name. */
export const SID_COOKIE = "rpxd_sid";

/**
 * Sign a session id as `<sid>.<base64url(HMAC-SHA256(sid, secret))>`.
 *
 * @example
 * ```ts
 * const value = signSessionId("abc", process.env.RPXD_SESSION_SECRET!);
 * // -> "abc.J1f…"
 * ```
 */
export function signSessionId(sid: string, secret: string): string {
  const mac = createHmac("sha256", secret).update(sid).digest("base64url");
  return `${sid}.${mac}`;
}

/** Verify a signed cookie value; returns the sid, or `null` if the MAC doesn't check out. */
function verifySignedSid(value: string, secret: string): string | null {
  const dot = value.lastIndexOf(".");
  if (dot <= 0) return null;
  const sid = value.slice(0, dot);
  const got = Buffer.from(value.slice(dot + 1));
  const want = Buffer.from(createHmac("sha256", secret).update(sid).digest("base64url"));
  // timingSafeEqual requires equal lengths — a length mismatch is already a fail.
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
  return sid;
}

/**
 * Constant-time string equality for security tokens (attach tokens, #61) — a
 * length pre-check (timingSafeEqual requires equal lengths) then a byte compare
 * that doesn't short-circuit on the first differing byte, so a token can't be
 * recovered from response timing.
 *
 * @example
 * ```ts
 * if (timingSafeEqualStr(entry.attach.token, given)) adopt();
 * ```
 */
export function timingSafeEqualStr(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(a);
  const eb = new TextEncoder().encode(b);
  return ea.length === eb.length && timingSafeEqual(ea, eb);
}

function cookieValue(req: Request): string | undefined {
  const cookie = req.headers.get("cookie") ?? "";
  const found = cookie
    .split(";")
    .map((c) => c.trim())
    .find((c) => c.startsWith(`${SID_COOKIE}=`));
  return found ? found.slice(SID_COOKIE.length + 1) : undefined;
}

/**
 * Resolve a request to a session id. A missing cookie mints a fresh sid
 * (`isNew`). With a `secret`, a present cookie must carry a valid signature —
 * a forged/unsigned one is rejected and mints a fresh sid too; without a secret
 * the raw value is trusted.
 *
 * @example
 * ```ts
 * const { sid, isNew } = readSid(req, process.env.RPXD_SESSION_SECRET);
 * ```
 */
export function readSid(req: Request, secret: string | undefined): { sid: string; isNew: boolean } {
  const value = cookieValue(req);
  if (value === undefined) return { sid: randomUUID(), isNew: true };
  if (!secret) return { sid: value, isNew: false }; // unsigned mode (no/empty secret)
  const sid = verifySignedSid(value, secret);
  return sid ? { sid, isNew: false } : { sid: randomUUID(), isNew: true }; // forged → fresh session
}
