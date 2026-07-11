---
title: RSC fields (experimental)
description: Server-rendered component subtrees as opaque state values — Flight is the serialization, patches are the transport. Opt-in behind rsc:true.
sidebar:
  order: 6
---

:::caution[Experimental]
RSC fields are behind the opt-in `rsc: true` flag and default to `rsc: false`.
They are strictly opt-in, so nothing in the core runtime depends on them.
:::

RSC (React Server Components) fields let a piece of state be a
**server-rendered component subtree** — the markdown renderer, the syntax
highlighter, and their heavy dependencies stay on the server and never ship to
the client. React's Flight format (the RSC serialization) serializes the
subtree, and rpxd's ordinary
[patch stream](/rpxd-live/concepts/wire-protocol/) carries it to the client.

## How it works

Wrap a component in `rsc(...)` inside `load` or a reducer. It becomes an
`RscField` marker (`{ $rsc: string }`) carrying a Flight payload — an opaque
field in your state:

```tsx
load: async (_url, ctx) => {
  const doc = await getDoc(ctx.params.slug);
  // Serialize before the mutator — patchState is sync by design.
  const body = await rsc(<Markdown source={doc.raw} />); // → RscField marker
  ctx.patchState((s) => {
    s.doc = doc;
    s.body = body;
  });
};
```

On the client, marked fields are deserialized when a patch or snapshot applies,
and `{state.body}` renders the hydrated subtree. To the rest of the system it's
just an opaque marker value in state — so it flows through storage, SSR, and
reconnect unchanged.

## Security: the `$rsc` key is reserved

:::caution[Reserved `$rsc` key]
`$rsc` is reserved for framework-produced Flight fields. **Never place
user-controlled data into state in the shape `{ $rsc: string }`.**

The client treats *any* state value shaped `{ $rsc: string }` as a trusted
Flight payload and hands it straight to `createFromReadableStream` — the
check is purely structural, not a forgeable brand. This is safe today because
only app-authored values and genuine `rsc()` output ever reach state, and
rpxd never decodes client input into state. But RSC/Flight deserialization
has been a high-severity sink in other frameworks (see CVE-2025-55182), so
treat `$rsc` as reserved as a defense-in-depth measure.
:::

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
in `rpxd.config.ts`, or per-run with `rpxd dev --rsc` / `--no-rsc`. The
kitchen-sink example's `/doc` page is a live RSC field.
