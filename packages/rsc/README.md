# @rpxd/rsc

RSC fields (§16): Flight-serialized server component subtrees as opaque
values *inside live state* — heavy rendering stays on the server, while
`'use client'` islands inside the subtree ship as their own chunks and
hydrate interactive.

Enable with `rsc: true` in `rpxd.config.ts`; the framework wires the
Flight runtime (`@vitejs/plugin-rsc`) into dev and build for you.

## Usage

```tsx
import { rsc } from "@rpxd/rsc";
import { DocBody } from "../lib/markdown.tsx"; // server component + islands

export default live("/doc")
  // `setup` is sync — the server-only RSC render is IO, so it runs in `load`.
  .setup(() => ({ body: null as unknown }))
  .load(async (_url, ctx) => {
    const body = await rsc(<DocBody source={initial} />);
    ctx.patchState((s) => { s.body = body; });
  }, { blockSsr: true })
  .rpc("append", (r) =>
    r.handler(async ({ text }, ctx) => {
      const body = await rsc(<DocBody source={next(ctx.state, text)} />);
      ctx.patchState((s) => { s.body = body; }); // patch replaces the field whole
    }),
  )
  .render(({ state }) => <section>{state.body}</section>);
```

## How it works

- `rsc(<Subtree />)` serializes to a Flight payload string that rides
  patches, snapshots, and storage like any other state — transport and
  persistence are unchanged.
- The package's `.` export is **conditional**: only the react-server graph
  (where handlers run under `rsc: true`) gets the serializer; every other
  bundle gets a small throwing stub, so the Flight runtime never leaks into
  client or SSR bundles.
- On render, marked fields are swapped for elements behind `Suspense`
  (`@rpxd/rsc/client`), memoized per payload — unchanged fields keep
  referential identity, and islands keep their local state when a live
  patch replaces the field around them.

## Constraints

- Never optimistic, and not for keystroke-frequency updates — patches
  replace the whole field and React reconciles.
- Anything interactive inside the subtree goes in its own `'use client'`
  module (that's how islands are declared everywhere in the RSC ecosystem).
