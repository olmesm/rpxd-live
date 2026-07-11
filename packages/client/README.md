# @rpxd/client

The browser side of rpxd: typed `Link`/`nav` navigation, plus the runtime
that applies live server updates and optimistic state.

```sh
bun add @rpxd/client
```

Not yet on npm — work from a clone of the repo for now.

Apps mostly meet this package through render props — the generated client
entry (from [`@rpxd/cli`](../cli)) wires everything automatically. Import it
directly for `Link`, `useNav`, and `RenderProps`.

## Usage

```tsx
import { Link } from "@rpxd/client";

<nav>
  <Link to="/org/$orgId/board" params={{ orgId }} search={{ filter: "done" }}>
    Board
  </Link>
</nav>;
```

Inside a live component you already have everything as props:

```tsx
.render(({ state, rpc, sync, keyOf, nav }) => /* plain React */)
```

React bindings (`useLiveStore`) live at `@rpxd/client/react`.

## What lives here

- **`LiveStore`** — client state. It holds `confirmed` (the server truth) and
  a queue of pending optimistic functions; the rendered view is always
  `replay(pending, confirmed)`, so rollback on error is free. It applies
  patch envelopes, coalesces same-tick rpc calls into one batch, and links
  optimistic temp ids to real ids (`keyOf` keeps React keys stable across
  the swap).
- **`LiveConnection`** — the transport. SSE plus HTTP POST by default, or a
  single duplex WebSocket with `transport: ws()`. It reconnects with
  exponential backoff and resends unacknowledged batches (the server dedupes
  by `rpcId`).
- **`LiveApp`** — the client shell. It renders the current route. A
  same-route navigation reuses the live connection; a route change swaps
  route and connection. Either way, the previous page stays interactive
  until the next page's snapshot arrives. A `{ redirect }` signal from a
  route's `guard` or `setup` (e.g. `throw redirect("/login")`) becomes a
  soft navigation to the target.
- **`Link` / `useNav`** — typed navigation. Route paths autocomplete from
  the generated route table. Path params are identity (navigating is a soft
  reload); search params are view state (`nav.patch` reruns `guard` +
  `load` with state preserved).

Docs: https://olmesm.github.io/rpxd-live/
