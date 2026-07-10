# @rpxd/testing

Unit-test harness for live objects: mount a route against the real runtime
— real queue, real patches, real pubsub, nothing mocked — behind a typed
facade. Mounting runs the production lifecycle in order — `guard` → `setup`
→ `load` — so initial state is loader-populated, and a guard deny or loader
redirect rejects the mount with the `RedirectError` the server maps to a 302.

## Usage

```ts
import { testLive } from "@rpxd/testing";
import route from "../routes/index.tsx";

const t = await testLive(route, { search: { filter: "done" } });
expect(t.state.filter).toBe("done");      // the loader already ran

await t.rpc.add({ text: "milk" });        // typed payload, resolves on ack
expect(t.state.todos).toHaveLength(1);    // live server truth

t.broadcast("room:1", "user.joined", { name: "ada" }); // as a peer instance
await t.settled();                        // streams, flushes, queue drained

await t.dispose();                        // aborts in-flight ctx.signal

// a deny-all guard rejects the mount, like the server's 302
await expect(testLive(adminRoute)).rejects.toMatchObject({ location: "/login" });
```

## The handle

- **`t.rpc.*`** — the route's exact rpc record (same keys and payload types
  the component's `rpc` prop has). Calls reject with the ack error on
  handler throw, validation failure, or unknown rpc. `t.call(name, payload)`
  is the untyped escape hatch.
- **`t.state` / `t.session`** — live getters onto server-confirmed state.
- **`t.envelopes`** — every envelope emitted since mount, in order: the
  wire, as a client connection would see it. Useful for protocol-level
  assertions (streaming chunks, acks, `append` ops).
- **`t.navigate(search)`** — reconciles the mounted instance to new search
  params, running `guard` then `load` exactly as a client navigation does.
- **`t.settled()`** — resolves once in-flight rpcs, scheduled patch
  flushes, and the mutation queue have drained. Await it before asserting
  on streamed or broadcast-driven state.
- **`t.broadcast(topic, event, payload)`** — publishes with a foreign
  sender id, so exclude-self semantics behave exactly as in production.
  Share one storage adapter between two `testLive` handles to test
  multiplayer:

```ts
const storage = memory();
const a = await testLive(route, { storage, id: "A" });
const b = await testLive(route, { storage, id: "B" });
```
