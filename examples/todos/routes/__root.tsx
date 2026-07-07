import type { ReactNode } from "react";

/**
 * HTML shell + providers (§14): static, no live state. Wraps every page
 * (including __404 and __error) inside the framework document.
 */
export default function Root({ children }: { children: ReactNode }) {
  return (
    <div data-shell="todos-root">
      <nav>
        <a href="/">todos</a> · <a href="/chat">chat</a> · <a href="/import">import</a> ·{" "}
        <a href="/doc">doc</a>
      </nav>
      {children}
    </div>
  );
}
