---
title: Pubsub & multiplayer
description: Per-session instances coordinated by broadcast — subscribe in setup, broadcast in rpcs, mutate in on handlers. Exclude-self by default.
sidebar:
  order: 4
---

Instances are **per-session** — there are no shared instances, no `key` or
`scope` on the live object. Multiplayer is achieved by having those per-session
instances coordinate through a broadcast bus, which the persistence layer
carries.

## The three calls

- **`ctx.subscribe(topic)`** — called in `setup` to join a topic.
- **`ctx.broadcast(topic, event, payload)`** — called in an rpc handler to
  publish an event to a topic.
- **`.on(event, (state, payload) => void)`** — a sync mutator run when a
  subscribed topic broadcasts that event.

```tsx
export default live("/org/$orgId/board")
  .setup((ctx) => {
    ctx.subscribe(`org:${ctx.params.orgId}`);
    return { projects: [] as Project[] };
  })
  .load(async (_url, ctx) => {
    const projects = await listProjects(ctx.params.orgId);
    ctx.patchState((s) => { s.projects = projects; });
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
  });
```

## Exclude-self by default

A broadcast excludes its sender by default — the sender already applied the
change in its own handler. Passing `{ self: true }` includes the sender, which
enables a **single code path**: the rpc *only* broadcasts, and *all* mutation
(including the sender's own) happens in the `on` handler. Choose whichever keeps
the reducer clearer.

## Instance affinity is gone

Because coordination is by broadcast rather than shared memory, any node can
host any session. There's no instance affinity to maintain — horizontal scaling
falls out of the model. The bus lives in the storage adapter (memory for a
single node, Redis for many).

For load-balancer guidance, Redis wiring, and the in-process-throttle caveat,
see [Scaling & multi-node](/rpxd-live/operations/scaling/).
