---
title: Routing
description: File-based routing with codegen — flat filenames, the watcher-maintained path literal, and why path params remount while search params don't.
sidebar:
  order: 4
---

Routing is file-based with codegen. Under the hood it uses
[wouter](https://github.com/molefrog/wouter), but wouter is unexported — the
public surface is `Link` and `nav`. The URL is identity.

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

## The path literal is a maintained mirror

Each page carries an in-file path literal — `live("/org/$orgId/board")`. The
filename is truth; the literal is its typed mirror, **scaffolded and maintained
by the `rpxd dev` watcher**. Rename the file and the literal is rewritten;
hand-edit the literal and it's corrected. Path params are inferred from the
literal, so `setup` and every `rpc` ctx get typed `params`.

## Generated route map

`rpxd dev` generates `.rpxd/routes.gen.ts` (committed). It merges a `Register`
interface that makes `Link` and `nav.navigate` typed:

```tsx
<Link to="/org/$orgId/board" params={{ orgId }} />
```

Unknown paths and missing/mistyped params are compile errors.

## Path params vs search params

This distinction drives the whole navigation model:

- **Path params are identity.** Navigating to a different `orgId` is a different
  instance — so navigation **remounts**.
- **Search params are view state.** They drive the `.load()` **loader** via
  `nav.patch(search)` — **no remount**. The loader is an async fn that writes
  page state; it runs after `setup` and on every change, latest-wins, and is the
  single place URL-dependent data (filters, pages) loads. The URL is the query
  key, so those views are shareable, bookmarkable, and rebuilt on cold wake.

In v1, search params are untyped (`Record<string, string | undefined>`); typed
per-route search schemas are a v2 item.
