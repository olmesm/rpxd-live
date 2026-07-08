# HTTP routes & authentication (proposal)

> **Status: design proposal.** The `authenticate(req, { sid })` hook and the
> `Scope` pattern ([`domain-layer.md`](./domain-layer.md)) ship today in
> `examples/todos`. The `route()` fluent API, the catch-all path segment, and
> the API-route file kind below are **not built yet** — this is the design
> we're committing to before writing them, so the pieces stay consistent with
> `live()` and the domain layer.

## `routes/` holds two file kinds

Today every file under `routes/` is a live object. The proposal adds a second
kind, distinguished by what the file exports:

| File            | Exports          | Serves                              |
| --------------- | ---------------- | ----------------------------------- |
| `*.tsx`         | `live(...)`      | a live object — SSR + stream (§1)   |
| `*.ts`          | `route(...)`     | a plain HTTP request/response route |

HTTP routes are matched **before** the SSR/`404` fallthrough (today a bare
`404` at `handler.ts:372`). Both kinds get the same §7 treatment: the filename
is truth, the in-file path literal is the watcher-maintained mirror, and each
gets an entry in `.rpxd/routes.gen.ts`. Nothing about the domain layer changes
— routes of either kind still call `domain/`, never `db` (see
[`domain-layer.md`](./domain-layer.md)).

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
  .post(async (req, ctx) => {           // ctx.scope, ctx.params — like a handler
    await handleStripe(req, ctx.scope);
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

**Catch-all segment.** `api.auth.$.ts` → `/api/auth/*` needs a splat segment
(`$`). This is the one routing feature `route()` requires that live routing
doesn't have yet; auth libraries always mount as a subtree (Next's `[...all]`,
TanStack's `$`), so the delegation route can't exist without it.

## Authentication

Auth splits into the same two halves Phoenix does — **resolve** (read the
request into "who's acting") and **issue** (log in / out, set cookies). rpxd
already unifies Phoenix's plug-vs-`on_mount` split: every entry point (SSR GET,
stream, each rpc POST) flows through the one `authenticate` hook.

### Resolve — `authenticate` + `Scope` *(ships today)*

`authenticate(req, { sid })` is rpxd's `fetch_current_scope`: it reads the
request and returns the value that becomes `ctx.session`, which routes turn into
a `Scope` (`scopeFrom`) and thread into `domain/`. See
[`domain-layer.md`](./domain-layer.md#scope--who-is-acting) for the `Scope`
type. With an auth library this is where its session lookup lands:

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
`/api/auth/*` subtree. `auth.ts` is the **second infra singleton, a sibling of
`db.ts`** — it lives at the app root, not in `domain/`, because it's
infrastructure that owns its own tables, not your business logic. It's imported
in exactly two places: the `authenticate` hook and the delegation route.

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
Read `scope.user`; reject if absent. Spec §10's "`mount` can reject → error
route" makes this the `require_authenticated_user` equivalent, and because the
rejection happens before any handler, `domain/` never sees an unauthenticated
call.

```tsx
// routes/dashboard.tsx
.mount(async (_p, ctx) => {
  const scope = scopeFrom(ctx.session);
  if (!scope.user) throw new Error("unauthorized"); // → __error (§10)
  return { widgets: await listWidgets(scope) };
})
```

**Open question — redirect from `mount`.** §10 gives "reject → error route" but
no documented `redirect()`, so a proper login bounce (rejected `mount` →
`/login`) is genuinely undesigned. This is the real gap in the auth story, more
than where files live.

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
│   └── api.auth.$.ts       #   /api/auth/*  route().all() → auth.handler
├── domain/                 # app core — bounded modules (Phoenix contexts)
│   ├── scope.ts            #   Scope type + scopeFrom(ctx.session)
│   ├── todos.ts            #   listTodos / addTodo / toggleTodo(scope, …)
│   └── todos/              #   (only once it grows) queries.ts, schema.ts
├── db.ts                   # db client singleton (Prisma / Drizzle / bun:sqlite)
├── auth.ts                 # auth-library instance (owns user/session tables)
└── rpxd.config.ts          # storage, transport, session.authenticate
```

Dependency direction stays one-way: `routes/` → `domain/` → (`db.ts`,
`auth.ts`). Routes touch `db`/`auth` only at the two seams that *are* the web
layer's job — the `authenticate` hook and the `api.auth` delegation.
