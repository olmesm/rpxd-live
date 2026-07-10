---
title: How rpxd compares
description: Where rpxd sits among the tools you already know — LiveView, React Query + tRPC, Convex/Liveblocks/PartyKit, and Next.js/Remix — as honest two-sentence comparisons, not a scorecard.
---

Where rpxd sits among the tools you already know — each comparison is two honest
sentences, not a scorecard.

## vs Phoenix LiveView

rpxd shares LiveView's instinct that the server owns state, but the client is
real React — your components, your ecosystem, hydrated in the browser — and
optimistic replay means an interaction paints immediately instead of waiting a
round trip. rpxd runs a per-session live object coordinated by pubsub rather
than one server process per connected view.

**Honest note:** LiveView is a decade more battle-tested, with a mature
ecosystem and production track record rpxd does not yet have.

## vs React Query + tRPC

rpxd deletes the query-key / cache / invalidation layer: the URL *is* the query
key, the `load` loader *is* the query, and invalidation is just the patch stream
arriving. The tRPC-style end-to-end types come from the same fluent chain — no
codegen, no generated client.

**Honest note:** that stack composes with any server architecture and any
framework; rpxd instead owns your page's server-state model end to end.

## vs Convex / Liveblocks / PartyKit

rpxd is self-hosted and DB-agnostic — the framework
[never touches your database](/rpxd-live/guides/domain-layer/) — and reactivity
is a per-page live object, not a synced database or a shared CRDT document.

**Honest note:** those platforms hand you hosted persistence, presence, and
CRDTs out of the box; rpxd gives you a live model over *your* database and
leaves persistence to you.

## vs Next.js / Remix (server components & actions)

An rpxd page is a long-lived stateful instance emitting a live patch stream, not
a request/response render — state persists across interactions and streams
diffs, rather than re-rendering per request. React Server Components are
available *inside* state, via [RSC fields](/rpxd-live/concepts/rsc/).

**Honest note:** for mostly-static pages or form-shaped apps, plain
request/response is simpler and rpxd's long-lived connection buys you nothing.

## When NOT to use rpxd

rpxd is the wrong tool for a few shapes of app.

- **Offline-first apps.** State lives server-side, and there is no offline
  story — an rpxd page needs a live connection to function.
- **Mostly-static content.** A blog, docs, or marketing site pays for a
  long-lived stateful instance it never uses; reach for static rendering or
  request/response.
- **Infra that can't hold long-lived connections.** rpxd streams over SSE/WS, so
  a platform that forbids persistent connections rules it out.

And rpxd is **pre-1.0**: the packages aren't on npm yet and APIs may still
change. Evaluate accordingly.
