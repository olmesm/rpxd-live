/**
 * Stand-in for a heavy rendering dependency (markdown + shiki, §16). Loaded
 * only inside server reducers via dynamic import — the e2e suite asserts
 * this module never executes in the browser.
 */
import type { ReactElement } from "react";

(globalThis as { __MARKDOWN_LOADED?: boolean }).__MARKDOWN_LOADED = true;

export function renderMarkdown(source: string): ReactElement {
  const blocks = source.split("\n").map((line, i) => {
    if (line.startsWith("# ")) {
      // biome-ignore lint/suspicious/noArrayIndexKey: static server render
      return <h2 key={i}>{line.slice(2)}</h2>;
    }
    const parts = line.split(/\*([^*]+)\*/g).map((part, j) =>
      // biome-ignore lint/suspicious/noArrayIndexKey: static server render
      j % 2 === 1 ? <em key={j}>{part}</em> : part,
    );
    // biome-ignore lint/suspicious/noArrayIndexKey: static server render
    return <p key={i}>{parts}</p>;
  });
  return <div className="markdown">{blocks}</div>;
}
