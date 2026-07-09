---
title: The kitchen-sink example
description: A tour of examples/kitchen-sink — the demo app that doubles as the acceptance suite, exercising optimistic todos, token streaming, multiplayer chat, CSV import, auth, and an RSC doc page.
sidebar:
  order: 1
---

`examples/kitchen-sink` is the reference app. It doubles as the acceptance suite —
Playwright runs against it across every transport and render combination — so
every page here is a working demonstration of a concept in these docs.

## Run it

```sh
git clone https://github.com/olmesm/rpxd-live
cd rpxd-live && bun install
cd examples/kitchen-sink && bun run setup   # prisma generate + db push
bun run dev                          # http://localhost:3000
```

<a
  href="https://stackblitz.com/github/olmesm/rpxd-live/tree/main/examples/kitchen-sink"
  target="_blank"
  rel="noopener"
>
  Open the source in StackBlitz →
</a>

:::note[On the StackBlitz link]
StackBlitz opens the example in an in-browser editor to **read and fork** the
source. rpxd's runtime needs **Bun** (`Bun.serve`, `bun:sqlite`), which
StackBlitz's Node-based WebContainers don't provide, so run the dev server
locally with `bun run dev`.
:::

## The pages

| Route | File | Demonstrates |
| --- | --- | --- |
| `/` | `index.tsx` | optimistic todos — add / toggle, `keyOf`, user-scoped queries; URL-driven [filtering](/rpxd-live/guides/filtering-and-search/) via the `params` loader |
| `/stream` | `stream.tsx` | streaming — `for await` + `append` patches (O(delta) wire), `ctx.abort` |
| `/chat` | `chat.tsx` | multiplayer — pubsub broadcast, single-code-path `on` handler (`self: true`) |
| `/import` | `import.tsx` | slow work — per-chunk `patchState`, `onError` repair |
| `/doc` | `doc.tsx` | an [RSC field](/rpxd-live/concepts/rsc/) — server-rendered markdown |
| `/login` | `login.tsx` | auth forms (Better Auth email/password) |
| `/account` | `account.tsx` | a [protected route](/rpxd-live/guides/routes-and-auth/#enforcing-auth--the-mount-gate) — `throw redirect("/login")` |
| `/api/auth/*` | `api.auth.$.ts` | the [delegation route](/rpxd-live/guides/routes-and-auth/) — `route().all()` |
| `/boom` | `boom.tsx` | the `__error` path — a deliberate mount crash |

## The shape

The app follows the [domain-layer convention](/rpxd-live/guides/domain-layer/):

```
examples/kitchen-sink/
├── routes/            # the edge — live objects + the auth route
├── domain/
│   ├── scope.ts       # Scope + scopeFrom — client-safe, no db
│   └── todos.ts       # listTodos / addTodo / toggleTodo (the only db caller)
├── adapters/
│   ├── db.ts          # the Prisma client + the Better Auth adapter
│   └── auth.ts        # betterAuth(...) consuming that adapter
├── lib/components/     # 'use client' islands + the RSC markdown renderer
├── prisma/schema.prisma
└── rpxd.config.ts
```

Read [App structure](/rpxd-live/guides/domain-layer/) and
[Routes & auth](/rpxd-live/guides/routes-and-auth/) alongside the code — the
example is laid out exactly as those guides describe.
