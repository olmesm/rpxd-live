---
title: RSC fields (experimental)
description: Server-rendered component subtrees as opaque state values — Flight is the serialization, patches are the transport. Opt-in behind rsc:true.
sidebar:
  order: 7
---

:::caution[Experimental]
RSC fields are behind the opt-in `rsc: true` flag and default to `rsc: false`.
They are strictly opt-in, so nothing in the core runtime depends on them.
:::

RSC fields let a piece of state be a **server-rendered component subtree** — the
markdown renderer, the syntax highlighter, and their heavy dependencies stay on
the server and never ship to the client. The React Flight format is the
serialization; rpxd's [patches](/rpxd-live/concepts/wire-protocol/) are the
transport.

## How it works

Wrap a component in `rsc(...)` inside `load` or a reducer. It becomes a Flight
string — an opaque field in your state:

```tsx
load: async (_url, ctx) => {
  const doc = await getDoc(ctx.params.slug);
  // Serialize before the mutator — patchState is sync by design.
  const body = await rsc(<Markdown source={doc.raw} />); // → Flight string
  ctx.patchState((s) => {
    s.doc = doc;
    s.body = body;
  });
};
```

On the client, marked fields are deserialized when a patch or snapshot applies,
and `{state.body}` renders the hydrated subtree. To the rest of the system it's
just a string in state — so it flows through storage, SSR, and reconnect
unchanged.

## Constraints

- **Never optimistic.** RSC fields can't be part of an optimistic update.
- **Not for keystroke-frequency updates.** A patch replaces the *whole* field
  (there's no Flight diffing); React reconciles the result. That's cheap for a
  rendered document, wasteful for a rapidly-changing value.
- **`'use client'` islands** hydrate via the plugin manifest.

## Under the hood

RSC is built on
[`@vitejs/plugin-rsc`](https://github.com/vitejs/vite-plugin-react) — rpxd
integrates it rather than owning the bundler layer. Enable it with `rsc: true`
in `rpxd.config.ts`, or per-run with `rpxd dev --rsc` / `--no-rsc`. The todos
example's `/doc` page is a live RSC field.
