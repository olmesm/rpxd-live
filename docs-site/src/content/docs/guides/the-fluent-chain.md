---
title: The fluent chain
description: The full live().mount().params().rpc().on().render() surface and how types flow through it with zero annotations.
sidebar:
  order: 1
---

`live()` is a fluent chain where each step *locks* something for the next. The
whole contract — state shape, payload types, the client-facing `rpc` facade — is
inferred. You write no type annotations, and unknown rpc names or wrong payloads
are compile errors.

```tsx
export default live("/org/$orgId/board")
  .mount(async ({ orgId }, ctx) => {
    ctx.subscribe(`org:${orgId}`);
    return { projects: await listProjects(orgId) };
  })
  .params((session, { filter }) => {
    session.filter = filter ?? "all";
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

### `.mount(async (params, ctx) => state)`

Runs server-side on page load (and on cold wake). Returns the initial state; its
shape **locks the state type** for `params`, every `rpc`, `on`, and `render`.
Path params (`orgId`) are typed from the path literal. Call `ctx.subscribe` here
to join pubsub topics. Mount may `throw redirect("/login")` to bounce (see
[Routes & auth](/rpxd-live/guides/routes-and-auth/)).

### `.params((session, search) => void)`

A reducer for **search-param** changes. Path params are identity (navigation =
remount); search params are view state, applied through this reducer via
`nav.patch` — no remount. Optional.

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
  *state*, not the database.
- **`.atomic()`** — buffer all `patchState` calls and flush once on success,
  discard all on throw (whole-rpc rollback).
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
| `sync` | `{ pending, errors }` — in-flight + failed rpcs |
| `nav` | `navigate(to, params)` and `patch(search)` |
| `keyOf` | maps a temp id to a stable React key across optimistic → confirmed |

## Why zero annotations

Each `.rpc(name, ...)` extends an accumulated `{ name → payload }` record. By
`.render()`, that record has become the `rpc` facade's type. The same types flow
through `optimistic`, `handler`, `onError`, **and** the client `rpc.*`
signature — with no codegen step. The fluent chain is construction-time only; it
evaluates to the same long-form object the server consumes at runtime. The
contract is locked by the type tests in
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
