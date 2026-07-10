---
title: Testing
description: Test live objects against the real runtime with the testLive harness — typed rpc calls, server-truth state, and the wire — plus the four test tiers rpxd uses.
sidebar:
  order: 12
---

rpxd is TDD-first: you write the failing test before the implementation. That's
practical because a live object is testable without a browser or a running
server — [`@rpxd/testing`](https://olmesm.github.io/rpxd-live/) mounts a route
against the **real** runtime (real queue, real patches, real pubsub, nothing
mocked) behind a typed facade.

## The `testLive` harness

`testLive(route)` mounts a route and hands back a typed handle. The mount runs
the production lifecycle stages in order — `guard` → `setup` → `load` — and
awaits the initial load, so a route's loader-populated state is there from the
first assertion. You call rpcs the way the component does, and assert on
server-confirmed state or on the wire.

```ts
import { testLive } from "@rpxd/testing";
import { describe, expect, it } from "vitest";
import todosRoute from "../routes/todos.tsx";

it("adds a todo", async () => {
  const t = await testLive(todosRoute);

  await t.rpc.add({ text: "milk" }); // typed payload; resolves on ack
  expect(t.state.todos).toHaveLength(1); // server truth
  expect(t.state.todos[0]?.text).toBe("milk");

  await t.dispose(); // aborts any in-flight ctx.signal
});
```

`t.rpc.*` carries the route's **exact** rpc record — the same keys and payload
types the component's `rpc` prop has, so a wrong name or payload is a compile
error.

### The handle

| Member | What it gives you |
| --- | --- |
| `t.state` / `t.session` | Live getters onto server-confirmed state and the session slice. |
| `t.rpc.*` | The typed [rpc facade](/rpxd-live/guides/the-fluent-chain/). Each call is one batch; the promise resolves on ack and **rejects** with the ack error on a handler throw, validation failure, or unknown rpc. |
| `t.call(name, payload)` | Untyped escape hatch, same semantics as `t.rpc.*`. |
| `t.envelopes` | Every envelope emitted since mount, in order — [the wire](/rpxd-live/concepts/wire-protocol/) as a client would see it. |
| `t.settled()` | Resolves once in-flight rpcs, scheduled patch flushes, and the mutation queue have drained. Await it before asserting on streamed or broadcast-driven state. |
| `t.navigate(search)` | Runs `guard` then `load` with new search params (see [routing](/rpxd-live/guides/routing/)), awaiting the stream to settle. |
| `t.broadcast(topic, event, payload)` | Injects a broadcast as if a **peer** instance published it ([pubsub](/rpxd-live/concepts/pubsub/)) — exclude-self semantics behave exactly as in production. |
| `t.dispose()` | Aborts in-flight `ctx.signal` and tears the instance down. |

Options: `testLive(route, { params, session, search, storage, id })` — typed
path params for the route literal, a session slice, the initial search params
the mount's `guard` + `load` run with, and a shared `storage` + distinct `id`
for multiplayer (below).

## Patterns

### Errors and validation

A handler throw or a rejected `input` schema surfaces as a rejected promise, and
confirmed state is left untouched:

```ts
await expect(t.rpc.add({ text: "" })).rejects.toMatchObject({
  name: "ValidationError",
});
expect(t.state.todos).toHaveLength(0);
```

### Streaming handlers

For a handler that flushes mid-flight (see
[async handlers & streaming](/rpxd-live/guides/async-handlers-streaming/)), drive it and await `settled()`, then
assert on the final state or on the chunk envelopes the flushes produced:

```ts
const p = t.call("run");
await t.settled();
expect(t.state.items).toEqual(["item-1", "item-2", "item-3"]);
// mid-handler flushes were captured as chunk envelopes (no rpcId)
expect(t.envelopes.some((e) => e.patches && !e.rpcId)).toBe(true);
await p;
```

### URL loads and guards

The mount already ran `guard` → `load` with the initial `search`, so a loader's
first write is assertable straight away — and `navigate` runs the same pair for
a subsequent URL change. Give a protected route a `session` to get past its
guard; a deny **rejects** the mount with the redirect the server would 302 to:

```ts
const t = await testLive(accountRoute, {
  session: { sid: "s1", user },
  search: { filter: "done" },
});
expect(t.state.filter).toBe("done"); // loader ran at mount

await t.navigate({ filter: "open" }); // a later URL change
expect(t.state.filter).toBe("open");

// unauthenticated mount bounces, exactly like production
await expect(testLive(accountRoute)).rejects.toMatchObject({ location: "/login" });
```

### Multiplayer

Share one `storage` adapter between two handles with distinct `id`s; broadcasts
cross the pubsub bus exactly as in production, exclude-self included:

```ts
import { memory } from "@rpxd/core";

const storage = memory();
const a = await testLive(chatRoute, { storage, id: "A" });
const b = await testLive(chatRoute, { storage, id: "B" });

await a.rpc.send({ text: "hi" });
await a.settled();
await b.settled();

expect(a.state.log).toEqual([]); // exclude-self default
expect(b.state.log).toEqual(["hi"]);
```

`testLive` asserts **server truth**. Client-side optimistic replay
([optimistic updates](/rpxd-live/guides/optimistic-updates/)) is best exercised
end to end with Playwright; use `testLive` to pin the server contract the
optimism mirrors.

## Domain-layer tests

The [domain layer](/rpxd-live/guides/domain-layer/) is plain functions, so its
pure parts unit-test with no harness at all, and you mock at the domain boundary
— coarse and stable — rather than reaching for a db handle on `ctx`:

```ts
import { scopeFrom } from "../domain/scope";
expect(scopeFrom({ sid: "s1" })).toEqual({ sid: "s1", user: undefined });
```

DB-backed domain queries are integration-tested end to end by the Playwright
suite.

## The four test tiers

Pick the tier that matches the surface under test:

| Tier | Where | Runs with |
| --- | --- | --- |
| **Unit** (Vitest) | `packages/*/test/` — reducers, queue, replay, `testLive` routes | `bun run test` |
| **Type** (`*.test-d.ts`) | `packages/*/test/` — the fluent chain's inferred types | `bun run test` (Vitest typecheck) |
| **Bun-runtime** | `packages/*/test-bun/` — needs the Bun runtime (`bun:sqlite`, `Bun.serve`, Vite-on-Bun) | `bun test packages/*/test-bun` |
| **e2e** (Playwright) | `e2e/` — SSR attach, reconnect, optimistic replay, multiplayer, streaming in a real browser | `cd e2e && bunx playwright test` |

## Scaffolded tests

`rpxd scaffold` writes a test alongside every resource by default (pass
`--no-test` to skip it) — see
[CLI generators](/rpxd-live/guides/cli-generators/). A `--kind page` resource
(the default) gets a `testLive` route test; a `--kind http` resource has no
rpcs, so it gets a plain domain test instead. The generated test is a real
starting point you own, not a placeholder.
