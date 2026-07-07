/**
 * Server component standing in for a heavy renderer (markdown/shiki). Mixes
 * static server markup with a 'use client' island — the §16 target shape.
 */
import { Counter } from "./counter.tsx";

export function Doc({ source }: { source: string }) {
  return (
    <article className="doc">
      <h2>{source}</h2>
      <p>rendered on the server, never shipped to the client</p>
      <Counter start={41} />
    </article>
  );
}
