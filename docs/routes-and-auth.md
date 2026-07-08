# HTTP routes & authentication

> **Status: implemented**, demonstrated end-to-end in `examples/todos` (sign
> up / in / out, user-scoped todos, a protected route). The `route()` fluent
> API, the catch-all path segment, the API-route file kind, the
> `authenticate(req, { sid })` hook, and `redirect()` from `mount` all ship.
> Auth is real **Better Auth** over **Prisma 7 / SQLite**, wired in
> `adapters/` — swap `adapters/auth.ts` for another library at the same seam
> and everything else stays.

## `routes/` holds two file kinds

Files under `routes/` come in two kinds, distinguished by what the file
exports:

| File            | Exports          | Serves                              |
| --------------- | ---------------- | ----------------------------------- |
| `*.tsx`         | `live(...)`      | a live object — SSR + stream (§1)   |
| `*.ts`          | `route(...)`     | a plain HTTP request/response route |

HTTP routes are matched **before** the SSR/`404` fallthrough. Both kinds get
the same §7 treatment: the filename is truth, the in-file path literal is the
watcher-maintained mirror, and each gets an entry in `.rpxd/routes.gen.ts`
(pages under `routeModules`/`routeTree`, HTTP routes under a separate
`routeHandlers` map — HTTP routes are never navigable or SSR'd). Nothing about
the domain layer changes — routes of either kind still call `domain/`, never
`db` (see [`domain-layer.md`](./domain-layer.md)).

## The `route()` fluent

`route()` is to request/response endpoints what `live()` is to pages: one
fluent surface, path params typed from the literal, and the same `scope` the
live layer resolves. It is **thin on purpose** — `live()` earns its depth by
threading state → payloads → optimistic → render props → client facade; a
`route()` threads almost none of that, so its whole value is uniformity and
path typing. Don't gold-plate it.

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

Same builder either way. Auth is not a special case — it's a `route()` whose
body happens to be a one-line delegation.

**Catch-all segment.** `api.auth.$.ts` → `/api/auth/*` uses a trailing `$`
splat segment (`matchHttpPath` captures the rest under `ctx.params.$`). Auth
libraries always mount as a subtree (Next's `[...all]`, TanStack's `$`), so the
delegation route relies on it.

## Authentication

Auth splits into the same two halves Phoenix does — **resolve** (read the
request into "who's acting") and **issue** (log in / out, set cookies). rpxd
already unifies Phoenix's plug-vs-`on_mount` split: every entry point (SSR GET,
stream, each rpc POST) flows through the one `authenticate` hook.

### Resolve — `authenticate` + `Scope`

`authenticate(req, { sid })` is rpxd's `fetch_current_scope`: it reads the
request and returns the value that becomes `ctx.session`, which routes turn into
a `Scope` (`scopeFrom`) and thread into `domain/`. See
[`domain-layer.md`](./domain-layer.md#scope--who-is-acting) for the `Scope`
type. With an auth library this is where its session lookup lands (the shipped
example uses a sync `auth.getSession(req)`; a library like Better Auth exposes
an async `auth.api.getSession({ headers })` — same seam):

```ts
// rpxd.config.ts
import { auth } from "./auth";
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
`/api/auth/*` subtree. `adapters/auth.ts` sits beside `adapters/db.ts` — both
are server-only infrastructure, not `domain/` business logic. `adapters/db.ts`
owns the Prisma client and exports the Better Auth adapter (`authAdapter`);
`adapters/auth.ts` consumes it, so db wiring and auth config stay separate.
`auth` is imported in exactly two places: the `authenticate` hook and the
delegation route.

### Two rules

1. **One fluent surface.** `route()` covers *every* non-live route, including
   the auth delegation. Do **not** invent an auth-flavored fluent that
   re-expresses the library's config —

   ```ts
   // ❌ don't — a leaky mirror of Better Auth's own config surface
   defineAuth().provider(github({ … })).emailPassword().session({ … })
   ```

   That config already exists in the library, in `auth.ts`, and it moves fast.
   Wrapping it buys nothing and breaks every release.

2. **The framework maintains the mirror, not the logic.** The §7 watcher may own
   a route's *derived* bits — its path literal, its `routes.gen.ts` entry —
   because those are projections of the filename, safe to rewrite. It must never
   own `auth.ts`, the scope shape, or a handler body: those are yours to edit,
   the same way nobody generates your `.mount()` body.

## Enforcing auth — the `mount` gate

A protected page enforces authn where it already runs server code: `mount`.
Read `scope.user`; if it's absent, **`throw redirect("/login")`** — the
`require_authenticated_user` equivalent. Because the bounce happens before any
handler, `domain/` never sees an unauthenticated call. `examples/todos` ships
`routes/account.tsx` doing exactly this.

```tsx
// routes/account.tsx
import { live, redirect } from "@rpxd/core";
import { scopeFrom } from "../domain/scope";

export default live("/account")
  .mount(async (_params, ctx) => {
    const scope = scopeFrom(ctx.session);
    if (!scope.user) throw redirect("/login");
    return { email: scope.user.email };
  })
  .render(({ state }) => <p>signed in as {state.email}</p>);
```

**`redirect()` works on both entry points.** A full page load gets a real
`302` (crawlable, no flash, no protected component shipped); a soft `Link`/`nav`
navigation gets a `{ redirect }` signal on the control-mount response, which
the client router turns into a soft navigation to the target. So `throw
redirect("/login")` behaves the same whether the visitor typed the URL or
clicked a link. (A plain `throw` still routes to `__error` per §10 — `redirect`
is the specific, recognised signal.)

## Auth transitions re-mount

`mount` reads `ctx.session` once and computes session-scoped state (a user's
todos). The warm per-session instance (§12) is normally reused across reloads
for continuity — but a login or logout changes *who* is acting, so that cached
state is stale. The handler compares the fresh `authenticate` result against
the instance's session and, when they differ, **evicts and re-mounts** (drops
the snapshot too) rather than adopting the warm instance. So after the auth
route sets/clears its cookie, a normal navigation to any page re-runs `mount`
with the new principal — no manual invalidation. Same session → warm instance
reused as before; the re-mount fires only on an actual auth change.

## `sid` vs the auth session

Two independent identities — don't collapse them:

- **`sid`** — rpxd's instance/transport key (which live-object bucket, which
  storage row). Lets one user hold two tabs = two instances.
- **`user`** — the authenticated identity, from the auth library's own session.

The `Scope` carries **both**: `{ sid, user }`. Per-user data scopes by
`user.id`; `sid` stays the instance key. Keeping `Scope` a plain struct threaded
into `domain/` (not the db on `ctx`) is what lets it hold two identities
cleanly.

## The userland tree

Everything above, laid out — the `examples/todos` shape plus the auth files:

```
my-app/
├── routes/                 # web edge — file-based (§7)
│   ├── __root.tsx          #   HTML shell + providers
│   ├── __404.tsx
│   ├── __error.tsx         #   mount rejection / 403 (§10)
│   ├── index.tsx           #   /            live object (todos)
│   ├── login.tsx           #   /login       live object (auth forms)
│   ├── account.tsx         #   /account     protected (throw redirect)
│   └── api.auth.$.ts       #   /api/auth/*  route().all() → auth.handler
├── domain/                 # app core — bounded modules (Phoenix contexts)
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

Dependency direction stays one-way: `routes/` → `domain/` → `adapters/`.
Routes touch `adapters/` only at the two seams that *are* the web
layer's job — the `authenticate` hook and the `api.auth` delegation.
