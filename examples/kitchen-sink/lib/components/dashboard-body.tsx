"use client";

import { LiveSlot } from "@rpxd/client";
import { type ReactElement, useState } from "react";
import ItemBoard from "../../routes/item.$id.tsx";
import FeaturedItem from "../../slots/featured-item.tsx";

/**
 * The dashboard's interactive body, a `'use client'` island (§16). It hosts the
 * `<LiveSlot>`s, so it must NOT load in the react-server graph — `@rpxd/client`
 * pulls in the router (a React context), which only exists in the browser/SSR
 * environments. Marking it a client island keeps that import graph out of the
 * react-server bundle; the routed page (`routes/dashboard.tsx`) imports it as a
 * client reference, exactly like `lib/components/like-button.tsx`.
 */
export function DashboardBody({
  state,
  rpc,
}: {
  state: { limit: number; limitType: string; notices: string[] };
  // biome-ignore lint/suspicious/noExplicitAny: the page rpc facade is exact but erased here
  rpc: any;
}): ReactElement {
  const [itemId, setItemId] = useState("1");
  const [view, setView] = useState<"summary" | "detail">("summary");
  const [deny, setDeny] = useState(false);

  return (
    <main data-testid="dashboard">
      <h1>rpxd dashboard</h1>

      {/* (1) Typed URL props — the number lands as a number (visit ?limit=20). */}
      <p data-testid="limit">
        limit: {state.limit} ({state.limitType})
      </p>

      {/* Cross-object bus: broadcast a notice onto the chat channel. */}
      <button type="button" data-testid="notify" onClick={() => void rpc.notify({ text: "ping" })}>
        notify chat
      </button>
      <ul data-testid="page-notices">
        {state.notices.map((n) => (
          <li key={n}>{n}</li>
        ))}
      </ul>

      {/* (2) A data-dependent slot addressed by page-derived props. */}
      <section data-testid="featured-controls">
        <button type="button" data-testid="feature-1" onClick={() => setItemId("1")}>
          feature 1
        </button>
        <button type="button" data-testid="feature-2" onClick={() => setItemId("2")}>
          feature 2
        </button>
        <button
          type="button"
          data-testid="view-toggle"
          onClick={() => setView((v) => (v === "summary" ? "detail" : "summary"))}
        >
          toggle view
        </button>
        <button type="button" data-testid="deny-toggle" onClick={() => setDeny((d) => !d)}>
          toggle deny
        </button>
      </section>
      <LiveSlot
        of={FeaturedItem}
        params={{ itemId }}
        props={{ view, deny }}
        fallback={<p data-testid="featured-fallback">no featured item</p>}
      />

      {/* (3) A routed page embedded as a slot — shares the /item/1 instance. */}
      <section data-testid="board-embed">
        <h2>embedded item board</h2>
        <LiveSlot
          of={ItemBoard}
          params={{ id: "1" }}
          fallback={<p data-testid="board-fallback">loading board…</p>}
        />
      </section>
    </main>
  );
}
