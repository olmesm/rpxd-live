# @rpxd/rsc

Put React Server Components (RSC) inside live state. A state field can hold a
server-rendered component subtree: heavy rendering stays on the server, the
result travels to the browser like any other live update, and `'use client'`
islands inside the subtree hydrate and stay interactive.

```sh
bun add @rpxd/rsc
```

Not yet on npm — work from a clone of the repo for now.

Enable with `rsc: true` in `rpxd.config.ts`; the framework wires the RSC
runtime (`@vitejs/plugin-rsc`) into dev and build for you.

## Usage

```tsx
import { rsc } from "@rpxd/rsc";
import { DocBody } from "../lib/markdown.tsx"; // server component + islands

export default live("/doc")
  // `setup` is sync — the server-only RSC render is IO, so it runs in `load`.
  // `load` awaits the render before its first patch, so SSR waits for it and
  // the body lands in the first HTML document (crawlable) — no flag needed.
  .setup(() => ({ body: null as unknown }))
  .load(async (_url, ctx) => {
    const body = await rsc(<DocBody source={initial} />);
    ctx.patchState((s) => { s.body = body; });
  })
  .rpc("append", (r) =>
    r.handler(async ({ text }, ctx) => {
      const body = await rsc(<DocBody source={next(ctx.state, text)} />);
      ctx.patchState((s) => { s.body = body; }); // patch replaces the field whole
    }),
  )
  .render(({ state }) => <section>{state.body}</section>);
```

## How it works

- `rsc(<Subtree />)` serializes the subtree with React's Flight format (the
  RSC serialization) into an `RscField` marker (`{ $rsc: string }`). The
  marker rides patches, snapshots, and storage like any other state value —
  transport and persistence are unchanged.
- Only server handler code running under `rsc: true` gets the real
  serializer. Every other bundle (client, SSR) gets a small throwing stub,
  so the Flight runtime never leaks into them.
- On render, marked fields are swapped for elements behind `Suspense`
  (`@rpxd/rsc/client`) and memoized per payload. Unchanged fields keep
  referential identity, and islands keep their local state when a live
  patch replaces the field around them.

## Constraints

- Never optimistic, and not for keystroke-frequency updates — each patch
  replaces the whole field and React reconciles.
- Anything interactive inside the subtree goes in its own `'use client'`
  module (that's how islands are declared across the RSC ecosystem).

Docs: https://olmesm.github.io/rpxd-live/concepts/rsc/
