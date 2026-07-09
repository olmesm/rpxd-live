/**
 * Node `ServerAdapter` — a seam placeholder (§13, §17: the seam is proven by
 * structure).
 *
 * The rpxd runtime handler is web-standard (`Request`/`Response`/
 * `ReadableStream`) with no Bun types past the {@link ServerAdapter}
 * boundary, so a Node adapter is a thin `node:http` bridge: the same
 * `toWebRequest`/`writeWebResponse` shape the dev server already uses, plus
 * `better-sqlite3` swapped into `@rpxd/storage-sqlite`. This package has no
 * implementation.
 *
 * @packageDocumentation
 */
export type { ServeHandle, ServeOptions, ServerAdapter } from "@rpxd/server-bun";

/**
 * Placeholder — throws; rpxd runs on Bun (§13).
 *
 * @example
 * ```ts
 * import { nodeAdapter } from "@rpxd/adapter-node";
 * nodeAdapter(); // throws — run rpxd on Bun (bunAdapter)
 * ```
 */
export function nodeAdapter(): never {
  throw new Error(
    "@rpxd/adapter-node has no implementation — run rpxd on Bun (bunAdapter). " +
      "The ServerAdapter seam is web-standard, so a Node adapter is intentionally small.",
  );
}
