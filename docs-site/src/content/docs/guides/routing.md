---
title: Routing
description: File-based routing with codegen — flat filenames, the watcher-maintained path literal, and why a path change reruns setup while a search change doesn't.
sidebar:
  order: 4
---

This page shows how to add pages and navigate between them. Routing is
file-based: a file under `routes/` is a page, and its filename is its path.
Codegen keeps navigation typed. The public surface is `Link` and `nav`.

## Filenames map to paths

Filenames are flat and split on dots:

| File | Path |
| --- | --- |
| `index.tsx` | `/` |
| `org.$orgId.board.tsx` | `/org/$orgId/board` |
| `api.auth.$.ts` | `/api/auth/*` (catch-all) |

A `$name` segment is a path param; a trailing `$` is a catch-all splat. `.tsx` /
`.jsx` files export a `live()` object (a page); `.ts` / `.js` files export a
`route()` (a plain HTTP endpoint — see
[Routes & auth](/rpxd-live/guides/routes-and-auth/)).

## The path literal is maintained for you

Each page carries an in-file path literal — `live("/org/$orgId/board")`. The
filename decides the real path; the literal is a typed copy of it, written and
kept in sync by the `rpxd dev` watcher. Rename the file and the literal is
rewritten; hand-edit the literal and it's corrected. Path params are inferred
from the literal, so `setup` and every `rpc` ctx get typed `params`.

## Generated route map

`rpxd dev` generates `.rpxd/routes.gen.ts` (committed). It merges a `Register`
interface that makes `Link` and `nav.navigate` typed:

```tsx
<Link to="/org/$orgId/board" params={{ orgId }} />
```

Unknown paths and missing/mistyped params are compile errors. (Under the hood
the router is [wouter](https://github.com/molefrog/wouter), but wouter is
unexported — `Link` and `nav` are the API.)

## Path params vs search params

This distinction drives the whole navigation model:

- **Path params are identity.** Navigating to a different `orgId` is a
  different instance — a **soft reload**. `setup` and `load` rerun with fresh
  state, and the page component (keyed by path) resets. On a same-route
  navigation the connection is reused: the SSE transport and app shell survive.
  A route change gets a new connection. Either way there's no full page load.
- **Search params are view state (a page's props).** They drive the `.load()`
  **loader** via `nav.patch(props)`. `setup` does not rerun, and state is preserved
  (keepPreviousData). The loader is an async function that writes page state.
  It runs after `setup` and on every change, latest-wins, and is the single
  place URL-dependent data (filters, pages) loads. Because the URL holds those
  params, the views are shareable and bookmarkable, and an instance rebuilt
  from scratch (a cold wake) restores them from the URL.

Search params are untyped (`Record<string, string | undefined>`) — narrow and
default them in the loader yourself.
