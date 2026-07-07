import { Link } from "@rpxd/client";
import type { ReactNode } from "react";

/**
 * HTML shell + providers (§14): static, no live state. Wraps every page
 * (including __404 and __error) inside the framework document. `Link`
 * navigation is soft (§7) — routes swap without a page load.
 */
export default function Root({ children }: { children: ReactNode }) {
  return (
    <div data-shell="todos-root">
      <nav>
        <Link to="/">todos</Link> · <Link to="/chat">chat</Link> · <Link to="/import">import</Link>{" "}
        · <Link to="/doc">doc</Link>
      </nav>
      {children}
    </div>
  );
}
