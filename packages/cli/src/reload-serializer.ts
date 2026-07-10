/**
 * Per-key latest-wins guard for `rpxd dev` reducer HMR reloads (#67).
 *
 * Reloading a changed route module is async (dynamic import through the SSR
 * graph). Two rapid saves of the same file start two reloads whose imports can
 * resolve OUT OF ORDER, so a naive apply would let the older module's def win
 * and leave the instance running stale code until the next save. Mirroring the
 * loader's `#loadRunId` tag in `packages/core/src/instance.ts`, each reload
 * claims a monotonically increasing tag per key; a reload only applies its
 * value if its tag is still the newest — a stale in-flight reload that resolves
 * after a newer one has started is dropped.
 *
 * @example
 * ```ts
 * const reload = createLatestWinsReloader<Mod>((route, mod) =>
 *   handler.updateRoute(route, mod.default.def),
 * );
 * // Two rapid saves of the same file: only the newest def is applied.
 * void reload("/counter", () => loadDefModule("counter.tsx"));
 * void reload("/counter", () => loadDefModule("counter.tsx"));
 * ```
 */
export function createLatestWinsReloader<T>(
  apply: (key: string, value: T) => void,
): (key: string, load: () => Promise<T>) => Promise<void> {
  const tags = new Map<string, number>();
  return async (key, load) => {
    const tag = (tags.get(key) ?? 0) + 1;
    tags.set(key, tag);
    const value = await load();
    // A newer reload for this key started while we awaited the import; its def
    // is the one on disk, so drop this stale one (#67).
    if (tags.get(key) !== tag) return;
    apply(key, value);
  };
}
