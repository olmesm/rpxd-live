---
title: Error handling
description: Where errors surface — rpc rejection, sync.errors + clearErrors, .onError() state repair, loader errors as state, the __error page, debugErrors disclosure, and rate limiting.
sidebar:
  order: 5
---

Errors don't have one path through rpxd — they have five, depending on where
they originate. This page is the map, plus the piece that was missing until
now: `sync.errors` is dismissable.

## The map

| Origin | Surface |
| --- | --- |
| Client-side `.input()` validation | rejected `rpc.*` promise, `sync.errors` |
| Server-side `.input()` validation | rejected `rpc.*` promise, `sync.errors` |
| Handler throw | rejected `rpc.*` promise, `sync.errors`, `.onError()` repair |
| `.rateLimit()` exhaustion | rejected `rpc.*` promise (`RateLimitError`), `sync.errors` |
| `load` throw | plain state — no ack, no `sync.errors` |
| Unmatched route / crash / denied `guard` | `__404` / `__error` page (server-rendered) |
| HTTP-level `throttle` exhaustion | `429` response, before any rpc runs |

The first four all funnel through the same rpc rejection + `sync.errors`
channel; loader failures are just state you set yourself; the last two are
server responses that never reach a live-object handler at all.

## rpc calls reject

`rpc.*` calls return a promise per batch: it resolves on ack, and **rejects**
with the ack error on a handler throw, a validation failure, or an unknown rpc
name (`packages/client/src/store.ts`, `LiveStore#call`). This is documented in
the [testing guide](/rpxd-live/guides/testing/) for the harness's `t.rpc.*`,
but the same contract holds for the browser's `rpc.*` render prop — it's the
same `LiveStore` underneath.

```tsx
try {
  await rpc.add({ text: "milk" });
} catch (e) {
  // e.message is the ack error's message; e.name is "ValidationError",
  // "RateLimitError", or whatever the handler threw.
  console.error("add failed:", e);
}
```

Client-side `.input()` validation runs *before* the optimistic update and
before anything is queued, so a rejected schema never shows an optimistic row
that then has to roll back — the promise just rejects immediately. Server-side
validation, a handler throw, and a `.rateLimit()` exhaustion all reject later,
on the ack: the optimistic view rolls back for free (the rendered `state` is
always `replay(pending, confirmed)`, so dropping the failed op *is* the
rollback — nothing to undo).

## `sync.errors` + dismissing them

Every rejection above (except the pre-flight client validation case, which
also pushes here) also lands in `sync.errors` — an array of
`{ name, message, rpc? }` surfaced to every render of the page, independent of
whether anything is `await`-ing the promise. That's the right shape for an
error-toast component, but until now there was no way to clear it from inside
`.render()`: `LiveStore.clearErrors()` existed on the client-only class, not on
the `sync` render prop.

`sync.clearErrors()` closes that gap:

```tsx
.render(({ sync }) => (
  <>
    {sync.errors.map((e, i) => (
      <p key={i} role="alert">
        {e.rpc ? `${e.rpc}: ` : ""}
        {e.message}
      </p>
    ))}
    {sync.errors.length > 0 && (
      <button onClick={sync.clearErrors}>Dismiss</button>
    )}
  </>
))
```

`clearErrors()` empties the array and is idempotent — safe to wire straight to
a dismiss button with no guard.

## `.onError()`: repairing state, not the database

A handler throw discards its unflushed draft and rejects the ack — but any
`patchState` calls that already flushed *before* the throw stay applied. If
the rpc declared `.onError((state, error, payload, ctx) => void)`, that sync
mutator runs as a queued flush right after, and its patches ride the same
error ack the rejection travels on. Use it to clear a spinner flag or record
how far a partial operation got:

```ts
.rpc("import", (r) =>
  r
    .input(z.object({ csv: z.string() }))
    .handler(async ({ csv }, ctx) => {
      ctx.patchState((s) => { s.importing = true; });
      for (const row of parseCsv(csv)) {          // throws mid-loop on a bad row
        ctx.patchState((s) => { s.rows.push(row); });
      }
      ctx.patchState((s) => { s.importing = false; });
    })
    .onError((s, err) => {
      s.importing = false;
      s.error = `import failed after ${s.rows.length} rows: ${(err as Error).message}`;
    }),
)
```

`examples/kitchen-sink`'s `/import` route (`routes/import.tsx`) is the live
demo: it streams rows in as they parse, then a deliberately malformed row
throws mid-stream, and `.onError` repairs `importing`/`error` while the
already-imported rows stay in state.

**Whole-rpc all-or-nothing is control flow, not a flag** — see
[Async handlers & streaming](/rpxd-live/guides/async-handlers-streaming/) and
the design note below. `.onError` repairs live-object *state*; it never
touches your database. If a handler's fallible work writes to storage, wrap
that in your own transaction inside `domain/` — `.onError` running after a
throw doesn't imply anything rolled back at the DB layer.

## Loader errors are just state

`load` has no ack and no `sync.errors` entry — a throw there either propagates
as a redirect (via `guard`, see
[HTTP routes & authentication](/rpxd-live/guides/routes-and-auth/)) or, more
commonly, you catch it yourself and write the failure into state exactly like
a loading flag:

```tsx
.load(async ({ search }, ctx) => {
  ctx.patchState((s) => { s.loading = true; s.error = null; });
  try {
    const items = await list(search, { signal: ctx.signal });
    ctx.patchState((s) => { s.items = items; s.loading = false; });
  } catch {
    ctx.patchState((s) => { s.loading = false; s.error = "Couldn't load."; });
  }
})
```

See [Loading data](/rpxd-live/guides/loading-data/) for the full loader model
— this is the same "loading, empty, and error are just state" pattern, applied
to the failure case.

## The `__error` page and `debugErrors`

An uncaught throw from `setup`, `guard`, or `load` — or any other request
crash — is handled server-side by `renderError` (`__error`, wired through
`RpxdHandlerOptions.renderError`). The framework never leaks the real error to
the client by default: production returns a generic `500` (or `403` for a
denied `authenticate`/`guard`), and the actual error is logged server-side via
`console.error`. Set `debugErrors: true` (the dev server does this
automatically) to echo the real message in the fallback plain-text body
instead of the generic one — `packages/server-bun/src/handler.ts`,
`safeErrorMessage()` and the `debugErrors` option. Note this only affects the
built-in plain-text fallback; a custom `renderError` owns its own disclosure
and should apply the same default-safe rule itself.

## Rate limiting

`.rateLimit({ capacity, refillPerSec })` on an rpc chain (or `defaultRateLimit`
app-wide, applied to any rpc that doesn't declare its own) attaches a
per-instance token bucket (`packages/core/src/rate-limit.ts`, `TokenBucket`).
An exhausted bucket throws `RateLimitError` from inside the same dispatch path
as a handler throw — so it surfaces exactly the same way: the `rpc.*` promise
rejects (`error.name === "RateLimitError"`) and the error lands in
`sync.errors`. No separate handling needed.

This is a different layer from the HTTP-level `throttle` option
(`RpxdHandlerOptions.throttle`), which token-buckets *requests* (SSR `GET`,
`/__rpxd/rpc`, `/__rpxd/control`) before they ever reach a live instance, keyed
by a function you supply from a trusted source. An over-limit request there
gets a `429` response — it never becomes an rpc call, so it never touches
`sync.errors`. See
[HTTP routes & authentication](/rpxd-live/guides/routes-and-auth/#session-cookie-security)
for the full throttle/security picture.

## Design note: why there's no `.atomic()`

There's no transaction flag on the fluent chain. Whole-rpc all-or-nothing is
plain control flow: do the fallible work first (or wrap it in `try/catch`),
accumulate results in locals, and call `patchState` once at the end — a throw
before that terminal write applies nothing, which is exactly what a rollback
buffer would have bought you, with no extra API to learn. `.onError` remains
for repairing state after a throw that *did* leave some `patchState` calls
applied earlier in the handler. The full reasoning — including why this is
strictly more flexible than an atomic flag, since a `catch` can recover,
partially commit, or rethrow — is in
[ADR 0001](https://github.com/olmesm/rpxd-live/blob/main/docs/adr/0001-rpc-rollback-and-ssr-sequencing.md).
