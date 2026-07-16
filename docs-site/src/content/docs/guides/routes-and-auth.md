---
title: HTTP routes & authentication
description: Plain HTTP endpoints via route(), the authenticate hook, and enforcing auth by throwing redirect() from guard. Demonstrated with Better Auth over Prisma/SQLite.
sidebar:
  order: 11
---

This page shows how to add login to an rpxd app, protect a page, and serve
plain HTTP endpoints (webhooks, auth callbacks) with `route()`.

Everything here is demonstrated end to end in the kitchen-sink example: sign up
/ in / out, user-scoped todos, a protected route. The example's auth is
**Better Auth** over **Prisma 7 / SQLite**, wired in `adapters/`. Swap
`adapters/auth.ts` for another library at the same spot and everything else
stays.

## `routes/` holds two file kinds

Files under `routes/` come in two kinds, distinguished by what the file exports:

| File            | Exports          | Serves                              |
| --------------- | ---------------- | ----------------------------------- |
| `*.tsx`         | `live(...)`      | a live object — SSR + stream        |
| `*.ts`          | `route(...)`     | a plain HTTP request/response route |

HTTP routes are matched **before** the SSR / `404` fallthrough. Both kinds get
the same [routing](/rpxd-live/guides/routing/) treatment: the filename decides
the path, the in-file path literal is kept in sync by the `rpxd dev` watcher,
and each gets an entry in `.rpxd/routes.gen.ts`
(pages under `routeModules` / `routeTree`, HTTP routes under a separate
`routeHandlers` map — HTTP routes are never navigable or SSR'd). Nothing about
the domain layer changes — routes of either kind still call `domain/`, never
`db` (see [App structure](/rpxd-live/guides/domain-layer/)).

## The `route()` fluent

`route()` is to request/response endpoints what `live()` is to pages: one fluent
surface, path params typed from the literal, and the same `scope` the live layer
resolves. It is deliberately thin. `live()` threads state, payloads, optimistic
functions, and render props through its chain; a `route()` has almost none of
that to thread. Its value is uniformity and path typing.

```ts
// routes/api.webhooks.stripe.ts  → /api/webhooks/stripe
export default route("/api/webhooks/stripe")
  .post(async (req, ctx) => {           // ctx.session, ctx.params, ctx.sid
    await handleStripe(req, ctx.session);
    return new Response(null, { status: 204 });
  });
```

**Implement vs delegate.** The terminal method is the only thing that varies:

- `.get` / `.post` / … — you implement that method's handler (the webhook above).
- `.all` — you forward *every* method/path to something that owns the subtree.

```ts
// routes/api.auth.$.ts  → /api/auth/*   (all methods, delegated)
export default route("/api/auth/$")
  .all((req) => auth.handler(req));
```

Same builder either way. Auth is not a special case — it's a `route()` whose body
happens to be a one-line delegation.

**Catch-all segment.** `api.auth.$.ts` → `/api/auth/*` uses a trailing `$` splat
segment (`matchHttpPath` captures the rest under `ctx.params.$`). Auth libraries
always mount as a subtree (Next's `[...all]`, TanStack's `$`), so the delegation
route relies on it.

**CSRF.** A state-changing `route()` method (`.post`/`.put`/`.patch`/`.delete`)
requires same-origin by default, same as the [control plane](#cross-site-protection--the-origin-policy).
`.get`/`.head`/`.options` stay exempt — a top-level nav is legitimately cross-site,
and `OPTIONS` is a CORS preflight. For a route that's deliberately cross-origin
(a public webhook, a delegated auth callback), opt out explicitly:

```ts
export default route("/api/webhooks/stripe")
  .crossOrigin()   // Stripe posts here from its own origin
  .post(async (req, ctx) => { /* … */ });
```

## Authentication

Auth splits into two halves — **resolve** (read the request into "who's acting")
and **issue** (log in / out, set cookies). Every entry point (SSR GET, stream,
each rpc POST) flows through the one `authenticate` hook, so there's a single
place identity is resolved.

### Resolve — `authenticate` + `Scope`

`authenticate(req, { sid })` reads the request and returns the value that becomes
`ctx.session`, which routes turn into a `Scope` (`scopeFrom`) and thread into
`domain/`. See
[App structure](/rpxd-live/guides/domain-layer/#scope--who-is-acting) for the
`Scope` type. With an auth library this is where its session lookup lands — the
shipped example uses Better Auth's async `auth.api.getSession({ headers })`:

```ts
// rpxd.config.ts
import { auth } from "./adapters/auth";
export default defineConfig({
  session: {
    authenticate: async (req, { sid }) => {
      const s = await auth.api.getSession({ headers: req.headers });
      return { sid, user: s?.user };   // → ctx.session → scopeFrom → domain/
    },
  },
});
```

### Issue — `auth.ts` + the delegation route

Logging in must *write* (verify credentials, mint a session, set a cookie) — the
read-only `authenticate` hook can't do it. That's the issuance half, and it's
what the catch-all `route().all()` above is for: the library owns the whole
`/api/auth/*` subtree. `adapters/auth.ts` sits beside `adapters/db.ts` — both are
server-only infrastructure, not `domain/` business logic. `adapters/db.ts` owns
the Prisma client and exports the Better Auth adapter (`authAdapter`);
`adapters/auth.ts` consumes it, so db wiring and auth config stay separate. `auth`
is imported in exactly two places: the `authenticate` hook and the delegation
route.

### Two rules

1. **One fluent surface.** `route()` covers *every* non-live route, including the
   auth delegation. Do **not** invent an auth-flavored fluent that re-expresses
   the library's config —

   ```ts
   // ❌ don't — a leaky mirror of Better Auth's own config surface
   defineAuth().provider(github({ … })).emailPassword().session({ … })
   ```

   That config already exists in the library, in `auth.ts`, and it moves fast.
   Wrapping it buys nothing and breaks every release.

2. **The framework maintains derived files, never your logic.** The routing
   watcher may own a route's *derived* bits — its path literal, its
   `routes.gen.ts` entry — because those follow from the filename and are safe
   to rewrite. It must never own `auth.ts`, the scope shape, or a handler body.
   Those are yours to edit, the same way nobody generates your `.setup()` body.

## Enforcing auth — the `guard`

A protected page enforces authn in `guard` — access control's **home**. `guard`
runs before `load` on *every* URL change (path or search), so it re-checks even
a spoofed or hand-edited `?param`. Read `scope.user`; if it's absent,
**`throw redirect("/login")`** — the `require_authenticated_user` equivalent.
Because the bounce happens before `load` and before any handler, `domain/` never
sees an unauthenticated call.

```tsx
// routes/todos.tsx
import { live, redirect } from "@rpxd/core";
import { scopeFrom } from "../domain/scope";
import { listTodos, type TodoRow } from "../domain/todos";

export default live("/todos")
  .setup(() => ({ todos: [] as TodoRow[] }))
  .guard((_url, ctx) => {
    if (!scopeFrom(ctx.session).user) throw redirect("/login");
  })
  .load(async (_url, ctx) => {
    const todos = await listTodos(scopeFrom(ctx.session));
    ctx.patchState((s) => {
      s.todos = todos;
    });
  })
  .render(({ state }) => <ul>{/* … */}</ul>);
```

**When the page's state *is* the user, the check can live in `setup`.** A route
with no `.guard()` can fail fast right in `setup` — a page whose skeleton depends
on the identity (e.g. `{ email: user.email }`) throws `redirect()` there instead
of adding a separate gate. (If you *do* add a `.guard()`, it runs first, before
`setup`, so a denied request never runs `setup` at all.)

```tsx
// routes/account.tsx
import { live, redirect } from "@rpxd/core";
import { scopeFrom } from "../domain/scope";

export default live("/account")
  .setup((ctx) => {
    const scope = scopeFrom(ctx.session);
    if (!scope.user) throw redirect("/login");
    return { email: scope.user.email };
  })
  .render(({ state }) => <p>signed in as {state.email}</p>);
```

**`redirect()` works from `setup` and `guard`, on both entry points.** A full
page load gets a real `302` — crawlable, no flash, and the protected component
is never shipped. A soft `Link` / `nav.patch` navigation instead receives the
deny over the live connection (a `{ redirect }` control message on SSE, a
`redirect` message on WebSocket), and the client router turns it into a soft
navigation. So `throw redirect("/login")` behaves the same whether the visitor
typed the URL or clicked a link. (A plain `throw` still routes to `__error` —
`redirect` is the specific, recognised signal.)

**The target autocompletes your routes.** `redirect("…")` suggests your app's
registered paths — the same `Register["routes"]` union that types `Link` and
`nav`. Unlike `Link` (which takes a path *pattern* plus typed `params`), a
redirect target is a *final URL*, so the type stays open: registered paths
autocomplete, while a dynamic value, a query string (`/login?next=…`), or a
non-page path like `/403` all still type-check.

## Auth transitions re-run `setup`

`setup` reads `ctx.session` once when it builds the skeleton, and `guard` /
`load` read it on each URL change. The warm per-session instance is normally
reused across reloads for continuity — but a login or logout changes *who* is
acting, so that cached state is stale. The handler compares the fresh
`authenticate` result against the instance's session and, when they differ,
**evicts and re-runs `setup`** (dropping the snapshot too). So after the auth
route sets/clears its cookie, a normal navigation re-runs `setup` with the new
principal — no manual invalidation. Same session → warm instance reused as
before; the re-setup fires only on an actual auth change.

:::caution
This is why `authenticate` should return a **stable session projection** (e.g.
`{ sid, user: { id, email } }`) rather than the auth library's full session
object — the handler compares projections to decide whether to re-run `setup`.
:::

## `sid` vs the auth session

Two independent identities — don't collapse them:

- **`sid`** — rpxd's instance/transport key (which live-object bucket, which
  storage row). Lets one user hold two tabs = two instances.
- **`user`** — the authenticated identity, from the auth library's own session.

The `Scope` carries **both**: `{ sid, user }`. Per-user data scopes by `user.id`;
`sid` stays the instance key. Keeping `Scope` a plain struct threaded into
`domain/` (not the db on `ctx`) is what lets it hold two identities cleanly.

## Session-cookie security

The `rpxd_sid` cookie is always `HttpOnly` and `SameSite=Lax`, and hardened two
more ways:

- **`Secure` by default.** The cookie only rides HTTPS — plus `http://localhost`
  (a secure context) and behind a TLS-terminating proxy. `bun run dev` turns it
  off so LAN / plain-HTTP dev still gets a session; override anywhere with
  `session.cookie.secure` in `rpxd.config.ts`.
- **HMAC-signed when you set a secret.** Set `RPXD_SESSION_SECRET` (or
  `session.secret`) and rpxd signs the sid, rejecting a forged or unsigned cookie
  as a brand-new session — closing session fixation and the cross-session
  storage-namespace collision (`sid` is the storage key). Without a secret the
  sid is unsigned and the server warns once; set one in production. Signing is
  integrity, not confidentiality — it pairs with the `Secure` cookie.

Two more request-level guards:

- **Throttle.** An opt-in per-key token bucket (`throttle` in `rpxd.config.ts`).
  You supply the key, and it must come from a **trusted** source such as a
  proxy-set header. The key function receives only the `Request`, so validate
  `X-Forwarded-For` at your proxy — a raw one is spoofable. Over-limit HTTP
  requests get `429`. The long-lived SSE stream is exempt, and with
  `transport: ws()` only the initial navigation is metered — frames after the
  socket upgrade bypass the HTTP entrypoint. The bucket is in-process, so
  multi-node deployments should rate-limit at the proxy/edge.
- **Error disclosure.** A crash returns a generic `500` (the real error logged
  server-side), and a rejected auth a generic `403`, by default — internal
  messages never reach the client. `bun run dev` echoes the detail locally (the
  `debugErrors` handler option).

## Cross-site protection — the origin policy

The live control plane (`/__rpxd/ws`, `/__rpxd/stream`, `/__rpxd/rpc`,
`/__rpxd/control`) carries ambient credentials, and the **same-origin policy
does not apply to WebSocket handshakes** — so without an origin check a
malicious page could open `wss://your-app/__rpxd/ws` with the logged-in
victim's cookies and drive rpc batches / read envelopes on their behalf
(cross-site WebSocket hijacking).

rpxd gates the control plane **same-origin by default**, before `authenticate`
runs. A cross-origin request whose `Origin` isn't allow-listed gets `403`; an
absent `Origin` (native apps, server-to-server, CLIs) is allowed, since the
attack is browser-only. SSR `GET` navigation is **not** gated — a top-level
navigation is legitimately cross-site. `route()` handlers get the same
treatment as the rest of the app: `GET`/`HEAD`/`OPTIONS` stay exempt (nav / CORS
preflight), but a state-changing method is same-origin by default too, with
`.crossOrigin()` as the explicit opt-out (see the CSRF note earlier on this
page).

A same-origin app needs no config. For a deliberate cross-origin deployment
(a separate admin origin, a native shell), widen the allowlist:

```ts
// rpxd.config.ts
export default defineConfig({
  // exact origins…
  allowedOrigins: ["https://admin.example.com"],
  // …or a predicate for wildcard subdomains / proxy-aware matching:
  // allowedOrigins: (origin) => new URL(origin).hostname.endsWith(".example.com"),
});
```

`allowedOrigins: ["*"]` opts back into the pre-check any-origin behavior — only
if you fully own the cross-origin exposure.

:::caution
The origin check is **defense in depth, not a cookie policy.** The framework's
own `rpxd_sid` cookie is `SameSite=Lax`, so browsers already withhold it from
cross-site sockets and fetches. But if your `authenticate` hook depends on an
app cookie set **without** `SameSite=Lax`/`Strict`, or on any non-cookie ambient
credential the browser attaches automatically (HTTP Basic, a client cert), that
credential *is* sent cross-site — the origin allowlist is what stops the request
before your auth hook ever sees it. Set your auth cookie `SameSite=Lax` (or
`Strict`) as well.
:::

The same-origin match is **host-based**, not scheme-based: behind a
TLS-terminating proxy the server sees `http`, so a strict scheme compare would
be unreliable. Use the `allowedOrigins` predicate form when you need
scheme- or proxy-aware matching.

## Your app's tree

Everything above, laid out — the kitchen-sink example's shape plus the auth
files:

```
my-app/
├── routes/                 # web edge — file-based
│   ├── __root.tsx          #   HTML shell + providers
│   ├── __404.tsx
│   ├── __error.tsx         #   setup/guard rejection / 403
│   ├── index.tsx           #   /            live object (todos)
│   ├── login.tsx           #   /login       live object (auth forms)
│   ├── account.tsx         #   /account     protected (throw redirect)
│   └── api.auth.$.ts       #   /api/auth/*  route().all() → auth.handler
├── domain/                 # app core — bounded modules
│   ├── scope.ts            #   Scope type + scopeFrom(ctx.session)
│   └── todos.ts            #   listTodos / addTodo / toggleTodo(scope, …)
├── adapters/               # server-only infrastructure
│   ├── db.ts               #   Prisma client + Better Auth adapter (authAdapter)
│   └── auth.ts             #   betterAuth(...) consuming authAdapter
├── lib/
│   └── components/         # shared UI (rsc renderers, 'use client' islands)
├── prisma/schema.prisma    # Todo + Better Auth models
├── prisma.config.ts
└── rpxd.config.ts          # storage, transport, session.authenticate
```

Dependency direction stays one-way: `routes/` → `domain/` → `adapters/`. Routes
touch `adapters/` only at the two points that *are* the web layer's job — the
`authenticate` hook and the `api.auth` delegation.
