---
title: Live slots & layouts
description: Embed a live object anywhere with `<LiveSlot>`, and keep a region alive across navigation with `__layout.tsx`. Identity params remount, props patch, and a layout's slot, connection, and React state all survive a page change.
sidebar:
  order: 10
---

This page shows how to put a live object somewhere other than a page. A page is
addressed by the URL; a **slot** is a live object you embed in plain React and
address yourself. Use one for a second live thing on the screen — a chat panel, a
featured card — that has its own behaviour but isn't the page.

The public surface is one component, `<LiveSlot>`, and one file, `__layout.tsx`.

## Declare the live object

A slot's live object is written exactly like a page — the same fluent chain. The
only difference is where the file lives and how it's mounted.

```tsx
import { live, redirect } from "@rpxd/core";
import { z } from "zod";

const schema = z.object({
  view: z.enum(["summary", "detail"]).default("summary"),
  deny: z.boolean().default(false),
});

export default live("/featured/$itemId", schema)
  .setup((ctx) => ({ itemId: ctx.params.itemId, view: "summary", bumps: 0 }))
  .guard(async ({ props }) => {
    if (props.deny) throw redirect("/denied");
  })
  .load(async ({ props }, ctx) => {
    ctx.patchState((s) => {
      s.view = props.view;
    });
  })
  .rpc("bump", (r) =>
    r.handler(async (_payload, ctx) => {
      ctx.patchState((s) => {
        s.bumps += 1;
      });
    }),
  )
  .render(({ state, rpc }) => (
    <section>
      <p>bumps: {state.bumps}</p>
      <button type="button" onClick={() => void rpc.bump({})}>bump</button>
    </section>
  ));
```

Two kinds of input, and the difference matters:

- **Identity is the pattern** — the `$itemId` segment. Its value is the instance
  key. A change to it is a different instance: the slot **remounts**, `setup`
  reruns, and interaction state (here, `bumps`) resets to zero.
- **Props are the view state** — the `live(pattern, schema)` schema. A prop
  change reruns `guard` and `load` on the *same* instance, so state is preserved.

The second argument to `live()` is optional. Pass a schema to declare props;
leave it off for an identity-only live object.

### Where the file lives

Any module that exports a `live()` object is discovered by codegen and registered
by its pattern — the same registration that lets the server build a page. A file
under `routes/` is additionally **served at its URL** by the router. A file
anywhere else — say `slots/` — is registered but has no URL: it's mounted only
where you import it. So the same live object can be a page, a slot, or both.

## Mount it with `<LiveSlot>`

Import the live object and hand it to `<LiveSlot>` — typed straight from the
import, no route string:

```tsx
import { LiveSlot } from "@rpxd/client";
import FeaturedItem from "../slots/featured-item.tsx";

<LiveSlot
  of={FeaturedItem}
  params={{ itemId }}
  props={{ view, deny }}
  fallback={<p>no featured item</p>}
/>;
```

- `of` — the live object (the module's default export). It types `params` and
  `props` for you.
- `params` — identity. Fills the pattern's `$` segments. A change remounts.
  Required even when the pattern has no params (pass `{}`).
- `props` — the patchable record. A change patches the running instance. Rapid
  same-tick changes coalesce into one patch with the final value.
- `fallback` — rendered until the first snapshot arrives, and whenever the slot
  is denied. Defaults to nothing.
- `onDeny` — called with the redirect location when a `guard` or `load` denies,
  at mount or later. The slot falls back to `fallback` and stays there.

A slot never server-renders; it mounts in the browser after the page hydrates,
shows `fallback`, then paints once its first state confirms. Denial is graceful:
flip `deny` on a live slot and it tears back down to `fallback` while everything
around it stays live.

## Keep a region alive with a layout

A slot on a page unmounts when you navigate away. To keep one alive across every
navigation, put it in a **layout**. A file named `routes/__layout.tsx` wraps every
page, and rpxd renders it *outside* the per-page key — so the layout, and anything
in it, mounts once per app session and survives page changes.

```tsx
import { Link, LiveSlot } from "@rpxd/client";
import type { ReactNode } from "react";
import ChatPanel from "../slots/chat-panel.tsx";

export default function Layout({ children }: { children: ReactNode }) {
  return (
    <div style={{ display: "flex", gap: "1rem" }}>
      <div style={{ flex: 1 }}>{children}</div>
      <aside>
        <LiveSlot of={ChatPanel} params={{ channel: "lobby" }} fallback={<p>loading chat…</p>} />
      </aside>
    </div>
  );
}
```

The current page arrives as `children`. A `<Link>` in the layout navigates the
page below without disturbing the panel beside it.

Three separate layers keep a layout slot painting across a navigation, and each
is a different thing surviving:

1. **React state** — the layout's own state, and the slot component's local state
   (a chat draft still in the input, say). The layout renders outside the page's
   key, so React never unmounts this tree.
2. **The instance** — the slot's identity key doesn't change on navigation, so the
   server reuses the same warm instance (a warm instance is one already in memory).
   Its `load` doesn't rerun redundantly; its state is exactly where you left it.
3. **The connection** — there is one connection for the whole app session. The
   stream is never closed on navigation, so the slot's live updates never pause.

What resets is the page below: it's keyed by URL, so each navigation remounts a
fresh page instance. That's the point — the page changes, the region around it
doesn't.

A layout slot can still drive navigation: it receives the real `nav`, so the chat
panel can send you to a new page. But a slot **doesn't own the URL** — its
identity and props come from the `params` and `props` you pass, not the address
bar. Navigating doesn't remount a layout slot.

## Mount a page inside a page

Because any live object is slottable, a page is too. Import a route module and
mount it as a slot:

```tsx
import ItemBoard from "../../routes/item.$id.tsx";

<LiveSlot of={ItemBoard} params={{ id: "1" }} fallback={<p>loading board…</p>} />;
```

The slot and the routed tab share **one instance** — the key is the same
`/item/1` either way. Open the board's own page in another tab and it's the same
live object: one state, one broadcast scope, edits in one place appear in the
other.

## When not to reach for a slot

A slot is for a thing with its own lifecycle — its own rpcs, its own multiplayer
scope. It is *not* for the rows of a list. If you find yourself mapping over data
to render `<LiveSlot>`s, stop: that's a collection that wants to be one live
object owning an array, not one instance per row. The rule, with worked examples,
is [Aggregates, not rows](/rpxd-live/concepts/aggregates-not-rows/).

rpxd nudges you the same way at runtime. Each session is capped at 32 live
objects by default, so the list-of-slots shape fails fast: past the cap a mount is
refused and renders its `fallback`. Well before that, mounting many sibling slots
at once logs a `slot-fanout-high` warning in development. Both point back to the
aggregates rule — the fix is almost always to fold the collection into a single
object.

## Typed URL props on a page

Props aren't only for slots. Declare a schema on a page and its URL search params
arrive **decoded**, not as raw strings:

```tsx
const schema = z.object({ limit: z.number().default(10) });

export default live("/dashboard", schema)
  .setup(() => ({ limit: 10 }))
  .load(async ({ props }, ctx) => {
    ctx.patchState((s) => {
      s.limit = props.limit; // the number 20 for /dashboard?limit=20
    });
  })
  .render(/* … */);
```

Visiting `/dashboard?limit=20` reaches `load` with `props.limit` as the number
`20`. Without a schema, search params stay raw strings for you to narrow yourself
(see [Filtering & search](/rpxd-live/guides/filtering-and-search/)). The decode
also keeps navigation soft: a typed link carrying `?limit=20` from another route
stays a soft navigation instead of a full page reload.
