---
title: The fluent chain
description: The full live().setup().guard().load().rpc().on().render() surface and how types flow through it with zero annotations.
sidebar:
  order: 1
---

This page walks the whole `live()` chain — every step a page is built from,
and how types flow between them. Each step locks something in for the next:
the state shape, the payload types, the `rpc` object your component calls. All
of it is inferred. You write no type annotations, and unknown rpc names or
wrong payloads are compile errors.

```tsx
export default live("/org/$orgId/board")
  .setup((ctx) => {
    ctx.subscribe(`org:${ctx.params.orgId}`);
    return { projects: [] as Project[], filter: "all", loading: true };
  })
  .load(async ({ search }, ctx) => {
    const filter = search.filter ?? "all";
    ctx.patchState((s) => {
      s.filter = filter;
      s.loading = true;
    });
    const projects = await listProjects(ctx.params.orgId, { filter, signal: ctx.signal });
    ctx.patchState((s) => {
      s.projects = projects;
      s.loading = false;
    });
  })
  .rpc("create", (r) =>
    r.input(z.object({ name: z.string() })).handler(async ({ name }, ctx) => {
      const p = await createProject(ctx.params.orgId, name);
      ctx.patchState((s) => {
        s.projects.push(p);
      });
      ctx.broadcast(`org:${ctx.params.orgId}`, "project.created", p);
    }),
  )
  .on("project.created", (state, p) => {
    state.projects.push(p);
  })
  .render(({ state, session, rpc, sync, keyOf }) => {
    /* plain React */
  });
```

## The steps

### `.setup((ctx) => state)`

Runs server-side on page load (and on cold wake), **synchronously**. Returns the
initial state skeleton; its shape **locks the state type** for `guard`, `load`,
every `rpc`, `on`, and `render`. Path params (`orgId`) are typed from the path
literal, on `ctx.params`. Call `ctx.subscribe` here to join pubsub topics. Being
sync makes "all data loads in `load`" a structural guarantee and keeps a
same-route path step's skeleton instant — no IO here. `setup` may
`throw redirect("/login")` as a coarse fail-fast, but auth's home is `guard` (see
[Routes & auth](/rpxd-live/guides/routes-and-auth/)).

### `.guard(async ({ params, search }, ctx) => void)`

Optional. **Auth.** Runs before `load` on **every URL change** (path *or*
search), so a spoofed or hand-edited `?userId=…` is re-checked — not just on the
first load. `throw redirect(...)` to deny; return to allow. `ctx` is
`{ params, session, signal }` — no `patchState`, because a guard decides access,
it doesn't write state.

### `.load(async ({ params, search }, ctx) => void)`

The **URL-keyed loader** — the single place URL-dependent data loads. Runs once
after `setup` (first paint) and again on every `nav.patch`. A search change
(`nav.patch`) runs only the loader: `setup` does not rerun, state is preserved,
and the new data streams in over the same connection. A same-route path change
reruns both `setup` and `load` with fresh state; the connection still survives.
The loader writes **page state** via `ctx.patchState`; `ctx.session` is
read-only. Loading and errors are ordinary state the loader writes — there is
no completion message to wait for.

The **first argument is the whole URL** — `{ params, search }`. `search`
(`?filter=…`) is untyped view state (`Record<string, string | undefined>`);
`params` (`/org/$orgId` → `orgId`) are typed from the route literal, the same as
in `setup` and rpc handlers — see `ctx.params.orgId` in the example above.

It's **latest-wins**: a newer invocation aborts the prior run's `ctx.signal` and
drops its late writes, so rapid filter/page changes resolve to the last URL.
Pass `ctx.signal` to `fetch` so a superseded load stops early. Because the URL
holds the filters and pages, those views are shareable and bookmarkable, and an
instance rebuilt from scratch (a cold wake) restores them from the URL.

During SSR the first document carries state through the loader's **first
patch**; everything after it streams. There is no flag — placement decides.
Patch synchronously before the first `await` and that early state renders
immediately, with the data streaming in after hydration (fast first paint).
Or `await` the data *before* the first `patchState`: the renderer waits for it,
so the first document is crawlable and data-complete.

See [Loading data](/rpxd-live/guides/loading-data/) for the full model and the
[pagination](/rpxd-live/guides/pagination/),
[infinite scroll](/rpxd-live/guides/infinite-scroll/), and
[filtering & search](/rpxd-live/guides/filtering-and-search/) patterns built on it.

### `.rpc(name, r => r.input().optimistic().handler().onError())`

Defines a reducer. The builder locks payloads and threads types:

- **`.input(schema)`** — a [Standard Schema](https://standardschema.dev)
  (Zod / Valibot / ArkType). Validated client-side (before the optimistic
  update) *and* server-side, and **locks the payload type** for later steps.
  Without it, the payload type comes from the handler's own annotation.
- **`.optimistic((state, payload, ctx) => void)`** — a sync, pure mutation
  applied instantly on the client. See
  [Optimistic updates](/rpxd-live/guides/optimistic-updates/).
- **`.handler(async (payload, ctx) => void)`** — the single terminal. Plain,
  streaming, and slow work are all just async functions. State writes go through
  `ctx.patchState`. See
  [Async handlers & streaming](/rpxd-live/guides/async-handlers-streaming/).
- **`.onError((state, error, payload, ctx) => void)`** — a sync mutator run as a
  queued flush when the handler throws; its patches ride the error ack. Repairs
  *state*, not the database. For whole-rpc all-or-nothing, do the fallible work
  first (or `try/catch` + accumulate) and `patchState` once at the end.
- **`.rateLimit(limit)`** — a per-rpc token bucket, per instance.

### `.on(event, (state, payload) => void)`

A sync mutator run when a subscribed topic broadcasts `event`. Broadcasts
exclude the sender by default; `{ self: true }` opts in, enabling a single code
path (rpc broadcasts only, all mutation in `on`).

### `.render(props => ReactNode)`

Plain React. Props are fully typed:

| Prop | What it is |
| --- | --- |
| `state` | current view (confirmed + optimistic replay) |
| `session` | the value your `authenticate` hook returned |
| `rpc` | exact-keyed facade — `rpc.create({ name })`; wrong name/payload won't compile |
| `sync` | `{ pending, inFlight, errors }` — in-flight count + failed rpcs; each error is `{ name, message, rpc? }` |
| `status` | connection status — `"connecting" \| "live" \| "reconnecting" \| "error"` |
| `nav` | `navigate(to, { params?, search? })` and `patch(search)` |
| `keyOf` | maps a temp id to a stable React key across optimistic → confirmed |

## Why zero annotations

Each `.rpc(name, ...)` extends an accumulated `{ name → payload }` record. By
`.render()`, that record has become the type of the `rpc` prop. The same types
flow through `optimistic`, `handler`, `onError`, **and** the client `rpc.*`
signature — with no codegen step. The contract is locked by the type tests in
[`packages/core/test/live.test-d.ts`](https://github.com/olmesm/rpxd-live/blob/main/packages/core/test/live.test-d.ts).

Here's the mechanic in miniature — **hover the identifiers** to see the inferred
types, and note that an undefined rpc name is a compile error:

```ts twoslash
// A simplified illustration of how the chain accumulates rpc types.
type RpcMap = Record<string, unknown>;
interface Live<State, Rpcs extends RpcMap> {
  rpc<Name extends string, Payload>(
    name: Name,
    handler: (payload: Payload, state: State) => void,
  ): Live<State, Rpcs & Record<Name, Payload>>;
  render(
    fn: (props: {
      state: State;
      rpc: { [K in keyof Rpcs]: (payload: Rpcs[K]) => void };
    }) => void,
  ): void;
}
declare function live<State>(initial: State): Live<State, {}>;
// ---cut---
live({ count: 0 })
  .rpc("inc", (_p: void, s) => { s.count += 1; })
  .rpc("add", (p: { by: number }, s) => { s.count += p.by; })
  .render(({ rpc }) => {
    rpc.add({ by: 2 });
    //  ^?
    // @ts-expect-error — "dec" was never defined as an rpc
    rpc.dec();
  });
```
