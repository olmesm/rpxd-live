# @rpxd/client

The rpxd browser runtime: optimistic replay over server-confirmed state,
transport batching, soft navigation, and the typed `Link`/`nav` surface.

Apps mostly meet this package through render props — the generated client
entry (from [`@rpxd/cli`](../cli)) wires everything below automatically.
Import from it directly for `Link`, `useNav`, and `RenderProps`.

## What lives here

- **`LiveStore`** — holds `confirmed` (server truth) plus a queue of pending
  optimistic fns; the rendered view is always `replay(pending, confirmed)`,
  so rollback on error is free. Applies patch envelopes (including `append`
  expansion), coalesces same-tick rpc calls into one batch, and links
  optimistic tempIds to real ids by position matching (`keyOf` keeps React
  keys stable across the swap).
- **`LiveConnection`** — the transport: SSE + HTTP POST by default, one
  duplex WebSocket with `transport: ws()`, exponential-backoff reconnects,
  and at-least-once batch resend (the server dedupes by `rpcId`).
- **`LiveApp`** — the client shell: renders the current route and, on
  navigation, either reuses the connection (a same-route path change — tier 2,
  the SSE transport and shell survive) or swaps route + connection (a different
  route — tier 3). The previous page stays interactive until the next page's
  snapshot arrives. A `{ redirect }` signal from a route's `guard`/`setup` (e.g.
  `throw redirect("/login")`) is turned into a soft navigation to the target.
- **`Link` / `useNav`** — typed navigation. Route paths autocomplete from
  the generated route table (`Register` interface merge); path params are
  identity (navigate = soft reload), search params are view state
  (`nav.patch` reruns `guard`+`load`, state preserved).

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
