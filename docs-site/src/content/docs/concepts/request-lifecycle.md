---
title: Request lifecycle
description: How a request flows through rpxd — the outer request pipeline every request passes through, and the inner live-object lifecycle a page mount runs.
sidebar:
  order: 1
---

Every request rpxd handles runs **two nested sequences**: an outer _request
pipeline_ that every request passes through, and — for a page mount — an inner
_live-object lifecycle_ that runs `setup`, `guard`, and `load`.

```text
handler.fetch(req)                          ← request pipeline
  ├─ resolve session   (cookie → sid, signature verified)
  ├─ origin policy     (control plane only)      → 403
  ├─ throttle          (opt-in, per key)         → 429
  ├─ authenticate                                → 403
  ├─ dispatch
  │    ├─ /__rpxd/stream        (SSE subscribe)
  │    ├─ /__rpxd/rpc     POST  (rpc batch)
  │    ├─ /__rpxd/control POST  (mount / resync / url / release)
  │    ├─ route()         any   (server HTTP route)
  │    └─ GET <page>            → mount + render
  │            └─ live-object lifecycle          ← nested
  │                 ├─ guard   (access gate)      → redirect (302)
  │                 ├─ setup   (initial state + subscriptions)
  │                 ├─ load    (URL loader)       → first patch renders, rest streams
  │                 └─ render  (SSR HTML + attach token)
  └─ catch → redirect (302) / not-found (404) / error (500)
```

## The request pipeline

Every request — a page navigation, an SSE stream, an rpc batch, a `route()`
call — enters through the one handler `fetch` and passes the same outer stages.

1. **Session resolution.** The `rpxd_sid` cookie is read into a session id
   (`sid`) — its signature verified when a secret is set, so a forged or unsigned
   cookie mints a fresh `sid` instead. An absent cookie mints one too and sets it
   on the response. The `sid` namespaces this browser's instances and snapshots.
2. **Origin policy.** The control-plane endpoints (`/__rpxd/ws|stream|rpc|
   control`) are **same-origin by default** — a cross-origin request whose
   `Origin` isn't allow-listed gets a `403`, checked _before_ authentication.
   SSR `GET` navigation and `route()` handlers are not gated (a top-level nav is
   legitimately cross-site). See the
   [wire protocol](/rpxd-live/concepts/wire-protocol/).
3. **Throttle.** An opt-in per-key token bucket (also before authentication, so a
   flood can't amplify auth/mount work); over-limit HTTP requests get a `429`,
   the SSE stream exempt. See
   [session security](/rpxd-live/guides/routes-and-auth/#session-cookie-security).
4. **Authentication.** The optional `authenticate` hook runs once; a throw is a
   `403`, and its return value is `ctx.session` for every reducer thereafter.
5. **Dispatch.** By path: the control-plane endpoints, then any `route()` HTTP
   route, otherwise a `GET` that matches a page runs the live-object lifecycle
   below. Anything unmatched is a `404`.
6. **Error mapping.** A thrown [`redirect()`](/rpxd-live/guides/routes-and-auth/)
   becomes a real `302`; a not-found becomes the `__404` page; any other
   (non-`debugErrors`) throw becomes a generic `__error` page (a `500`) with the
   detail logged server-side.

## The live-object lifecycle

A page mount — whether from an SSR `GET` or a `control` `mount` — runs the live
object through its stages, in the order `guard → setup → load`. (The fluent
chain is declared `.setup().guard().load()`, but on a **fresh** mount `guard`
runs first, so a denied request never runs `setup` and allocates nothing.)

1. **`guard`** — gates access, first. A deny throws `redirect()`, which the
   pipeline maps to a `302` (SSR) or a client soft-navigation (runtime). Gate on
   `session`/`params`, not on state — it runs before `setup` exists. Re-runs on
   every URL change of a live instance.
2. **`setup`** — synchronous. Computes the initial state from `params` and
   `session`, and wires any pubsub [subscriptions](/rpxd-live/concepts/pubsub/).
   Runs once per instance identity; a cold wake re-runs it.
3. **`load`** — the URL loader. Writes page state through `ctx.patchState`. The
   first patch renders and everything after it streams, so loader shape controls
   the first paint (see [SSR](/rpxd-live/concepts/ssr/)). Re-runs on every URL
   change, latest-wins.
4. **`render` / attach** — SSR emits the HTML plus an embedded
   `{ snapshot, seq, attachToken }`; the live connection then **adopts** the
   warm instance rather than mounting again (see
   [SSR](/rpxd-live/concepts/ssr/)).

After the first paint the instance stays live: rpc batches mutate it, broadcasts
fan in, and when the last subscriber leaves it is snapshotted and evicted after
a warm TTL (see [persistence](/rpxd-live/concepts/persistence/)).

## Where a request ends

| Stage | Outcome |
| --- | --- |
| Session resolution | always continues (mints a `sid` if absent) |
| Origin policy (control plane) | cross-origin, not allow-listed → `403` |
| `authenticate` throws | `403` |
| `guard` denies | `302` (SSR) or soft-nav (runtime) |
| `load` throws `redirect()` before first patch | `302` |
| No route matches | `404` (the `__404` page) |
| Any other throw | `500` (the `__error` page) |

The transport is the same whether envelopes flow over SSE or a WebSocket — only
the framing differs (see [transports](/rpxd-live/concepts/transports/)).
