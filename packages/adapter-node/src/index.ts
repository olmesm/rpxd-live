/**
 * Node `ServerAdapter` — v2 stub (§13, §17: the seam is proven by structure).
 *
 * The rpxd runtime handler is web-standard (`Request`/`Response`/
 * `ReadableStream`) with no Bun types past the {@link ServerAdapter}
 * boundary, so this adapter is ~100 lines of `node:http` bridging when it
 * lands: the same `toWebRequest`/`writeWebResponse` shape the dev server
 * already uses, plus `better-sqlite3` swapped into `@rpxd/storage-sqlite`.
 *
 * @packageDocumentation
 */
export type { ServeHandle, ServeOptions, ServerAdapter } from "@rpxd/server-bun";

/**
 * Placeholder — throws until the Node adapter ships (v2, §13).
 *
 * @example
 * ```ts
 * import { nodeAdapter } from "@rpxd/adapter-node";
 * nodeAdapter(); // throws: run rpxd on Bun (bunAdapter) for now
 * ```
 */
export function nodeAdapter(): never {
  throw new Error(
    "@rpxd/adapter-node is a v2 stub — run rpxd on Bun (bunAdapter) for now. " +
      "The ServerAdapter seam is web-standard, so this adapter is intentionally small.",
  );
}
