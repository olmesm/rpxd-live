import type { ReactNode } from "react";

/**
 * The persistent region (ADR 0002 item 13): static React rendered inside
 * `RpxdProvider` but OUTSIDE `key={pathname}`, so it — and any `<LiveSlot>` it
 * hosts — is mounted once per app session and survives every navigation. Item 16
 * turns this into the dashboard's persistent chat panel; for now it is a neutral
 * wrapper that proves the region composes into SSR (`Root(Layout(page))`) and
 * hydrates in place.
 */
export default function Layout({ children }: { children: ReactNode }) {
  return <div data-shell="app-layout">{children}</div>;
}
