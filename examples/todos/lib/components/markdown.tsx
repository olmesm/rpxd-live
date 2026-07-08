/**
 * Stand-in for a heavy rendering dependency (markdown + shiki, §16). Loaded
 * only inside server reducers via dynamic import — the e2e suite asserts
 * this module never executes in the browser. `DocBody` mixes the server
 * markup with a 'use client' island (§16 step 2): the island ships, the
 * renderer doesn't.
 */
import type { ReactElement } from "react";
import { LikeButton } from "./like-button.tsx";

(globalThis as { __MARKDOWN_LOADED?: boolean }).__MARKDOWN_LOADED = true;

/** The rsc-field subtree: rendered markdown plus an interactive island. */
export function DocBody({ source }: { source: string }) {
  return (
    <div className="doc-body">
      {renderMarkdown(source)}
      <LikeButton initial={7} />
    </div>
  );
}

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
