import { Link, LiveSlot } from "@rpxd/client";
import type { ReactNode } from "react";
import ChatPanel from "../slots/chat-panel.tsx";

/**
 * The dashboard shell (ADR 0002 items 13 + 16): static React rendered inside
 * `RpxdProvider` but OUTSIDE `key={pathname}`, so it — and the `<LiveSlot>` it
 * hosts — mounts once per app session and survives every navigation.
 *
 * The persistent chat panel sits on the left; the routed app renders on the
 * right (`{children}`). Because a layout has no URL awareness, the chat channel
 * is static ("lobby"). This is the doctrine's positive case on screen: chat has
 * its own lifecycle, so it earns a slot — and its persistence is structural
 * (instance warm-reused, connection app-lifetime, this tree never unmounted).
 *
 * The routed page comes **first in source order** so a page's own form stays the
 * first `button[type="submit"]` on the document; the chat panel is a secondary
 * region, pulled visually left with flex `order`.
 */
export default function Layout({ children }: { children: ReactNode }) {
  return (
    <div data-shell="app-layout" style={{ display: "flex", gap: "1rem" }}>
      <div style={{ flex: 1 }}>
        {/* Soft navigation (Link) keeps the shell — and the chat slot — mounted. */}
        <nav data-testid="shell-nav">
          <Link to="/dashboard">dashboard</Link> ·{" "}
          <Link to="/item/$id" params={{ id: "1" }}>
            item
          </Link>{" "}
          · <Link to="/stream">stream</Link> · <Link to="/">todos</Link>
        </nav>
        {children}
      </div>
      <aside data-testid="chat-panel-slot" style={{ order: -1, minWidth: "16rem" }}>
        <LiveSlot
          of={ChatPanel}
          params={{ channel: "lobby" }}
          fallback={<p data-testid="chat-fallback">loading chat…</p>}
        />
      </aside>
    </div>
  );
}
