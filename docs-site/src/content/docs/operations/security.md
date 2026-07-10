---
title: Security
description: The consolidated security surface — session-cookie hardening, the cross-site origin policy, throttling, capacity caps as DoS hardening, error disclosure, and the onSecurityEvent observability hook.
sidebar:
  order: 4
---

rpxd's security posture is mostly "secure by default, with an explicit
opt-out": the session cookie, the control-plane origin check, and the
capacity caps all ship locked down. This page is the map of every
security-relevant knob and what it defends against; the two written up in
full depth — the cookie and the origin policy — live in
[HTTP routes & authentication](/rpxd-live/guides/routes-and-auth/) and are
linked below rather than repeated.

## Session cookie

`rpxd_sid` is always `HttpOnly` and `SameSite=Lax`, and `Secure` by
default — HTTPS-only, plus `http://localhost` (a secure context) and behind a
TLS-terminating proxy; only non-localhost HTTP dev needs
`session.cookie.secure: false`. Set `RPXD_SESSION_SECRET` (or
`session.secret` in `rpxd.config.ts`) to HMAC-sign the sid: a forged or
unsigned cookie is then rejected as a brand-new session, closing session
fixation and the `${sid}:${path}` storage-namespace collision. Without a
secret the sid is unsigned and the server warns once on startup — set one in
production. Signing is integrity, not confidentiality; it pairs with the
`Secure` cookie for that. Full detail:
[Session-cookie security](/rpxd-live/guides/routes-and-auth/#session-cookie-security).

## Cross-site protection — the origin policy

The control plane (`/__rpxd/ws|stream|rpc|control`) carries ambient
credentials, and the same-origin policy does **not** apply to WebSocket
handshakes — without a check, a malicious page could open a duplex socket
with a logged-in victim's cookies. rpxd gates the control plane same-origin
by default, checked *before* `authenticate` runs, so the auth hook is never a
cross-site side-channel; a rejected request gets `403`. An absent `Origin`
header (native apps, server-to-server calls, CLIs) is allowed — the attack is
browser-only. SSR `GET` navigation and `route()` handlers are never gated — a
top-level nav is legitimately cross-site. Widen the allowlist with an exact
array, a predicate (for wildcard subdomains / proxy-aware matching), or
`["*"]` to opt back into any-origin. Full detail:
[Cross-site protection](/rpxd-live/guides/routes-and-auth/#cross-site-protection--the-origin-policy).

## Throttling

The `throttle` option is an opt-in, per-key token bucket over the HTTP
request paths (SSR `GET`, `/__rpxd/rpc`, `/__rpxd/control`), checked before
`authenticate`; over-limit requests get `429`. The long-lived
`/__rpxd/stream` SSE connection is exempt — a native `EventSource` can't
reconnect after a non-200, so a `429` there would permanently kill the live
channel.

The key **must come from a trusted source**. `key(req)` only sees the
`Request`, so a raw `X-Forwarded-For` is client-spoofable — an attacker
rotating it gets a fresh bucket per request and the limiter does nothing.
Validate/set that header at your proxy and key off the value it guarantees.

Buckets are in-process (single-node); multi-node deployments need to
rate-limit at the proxy/edge instead. And with `transport: ws()`, throttling
only sees the **initial navigation** — once a socket is upgraded, its frames
never pass back through `fetch`, so post-upgrade traffic bypasses the HTTP
entrypoint entirely. Rate-limit the upgrade itself at the edge for WS apps.

## Capacity caps as DoS hardening

Independent of throttling, the instance registry bounds itself so scan
traffic or a single runaway session can't grow memory unbounded:

- **`maxUnattachedInstances`** (default 1024) — a hard cap on instances no
  client has ever attached to (a cookieless GET from a crawler or bot warms
  one that's never adopted). Exceeding it evicts the least-recently-used
  un-attached instance, without a snapshot.
- **`unattachedTtlMs`** (defaults to `attachTtlMs`) — how long a never-attached
  instance survives before eviction; it only needs to outlive its SSR attach
  window.
- **`maxInstancesPerSession`** (default 32) — a per-session ceiling. A fresh
  mount at the cap first evicts the session's oldest idle instance to make
  room; if every held instance is subscribed to a live connection, the mount
  is rejected (`429` on HTTP, an error envelope on WS) instead of pinning
  unbounded instances.

These, plus `warmTtlMs` and `attachTtlMs`, are configurable through the
`instances` block on `RpxdConfig`:

```ts
// rpxd.config.ts
export default defineConfig({
  instances: {
    maxUnattachedInstances: 200,
    maxInstancesPerSession: 16,
    unattachedTtlMs: 5_000,
  },
});
```

Omit any field to keep the handler's default. See also
[Eviction](/rpxd-live/concepts/transports/#eviction) for how the warm TTL
fits into connection lifecycle.

## Error disclosure

A crash returns a generic `500` (the real error logged server-side via
`console.error`), and a rejected `authenticate`/`guard` a generic `403`, by
default — internal messages never reach the client. `bun run dev` sets
`debugErrors: true` so the fallback body echoes the real message locally; a
custom `renderError` owns its own disclosure and should apply the same
default-safe rule itself. See
[The `__error` page and `debugErrors`](/rpxd-live/operations/error-handling/#the-__error-page-and-debugerrors)
for the full error-handling map.

## Observability: `onSecurityEvent`

Every rejection or capacity eviction above fires a `SecurityEvent` if you
provide `onSecurityEvent` — a single hook for logging or metering the whole
security surface instead of re-deriving it from access logs. The taxonomy is
exactly four types:

| `type` | Fired when |
| --- | --- |
| `origin-rejected` | Control-plane request failed the origin check |
| `rate-limited` | `throttle` bucket exhausted for a key |
| `cap-evicted` | An idle/un-attached instance was shed to stay under a capacity cap |
| `cap-rejected` | A mount was rejected — every slot at `maxInstancesPerSession` was subscribed |

The runtime swallows any throw from the hook, so a broken logger can't affect
the request it's observing:

```ts
// rpxd.config.ts
export default defineConfig({
  onSecurityEvent: (e) => {
    logger.warn(`rpxd.security.${e.type}`, e.detail);
  },
});
```
