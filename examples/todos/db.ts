/**
 * Todo data access over Prisma/SQLite. Prisma is loaded **lazily** — a dynamic
 * import of the server-only `./prisma` module — so a route component that
 * imports the domain layer (and transitively this file) never pulls
 * `@prisma/client` into the client bundle, where it would crash at init. The
 * import resolves only when a query runs, which is always server-side.
 */

/** A persisted todo row (the subset the UI needs). */
export interface TodoRow {
  id: string;
  text: string;
  done: boolean;
}

const select = { id: true, text: true, done: true } as const;
// `srv-` ids mark server-confirmed rows (vs optimistic tempIds, §4).
const newId = () => `srv-${crypto.randomUUID()}`;

// Load the Prisma client lazily AND server-only. `import.meta.env.SSR` is a
// static `false` in the Vite client build, so this dynamic import (and all of
// `@prisma/client`, which uses `node:crypto`) is tree-shaken out of the browser
// bundle; on the server it's `true`. Route components import this file freely.
const client = () => {
  // The import must live INSIDE the statically-`false` branch so the client
  // build prunes the whole edge to `./prisma` (and `@prisma/client`).
  if (import.meta.env.SSR) return import("./prisma").then((m) => m.prisma);
  throw new Error("db access is server-only");
};

export const db = {
  todos: {
    /** All of `owner`'s rows (oldest first); a new owner is seeded a starter row. */
    async all(owner: string): Promise<TodoRow[]> {
      const prisma = await client();
      const rows = await prisma.todo.findMany({
        where: { owner },
        orderBy: { created: "asc" },
        select,
      });
      if (rows.length > 0) return rows;
      // Seed keeps the default cuid (not a `srv-` id) so tests/UI can tell a
      // seeded row from a server-confirmed insert.
      const seed = await prisma.todo.create({ data: { owner, text: "Try rpxd" }, select });
      return [seed];
    },
    /** Insert a row for `owner`; returns it. */
    async insert(owner: string, text: string): Promise<TodoRow> {
      const prisma = await client();
      return prisma.todo.create({ data: { id: newId(), owner, text }, select });
    },
    /** Flip `done` for one of `owner`'s rows; returns it, or `undefined` if absent. */
    async toggle(owner: string, id: string): Promise<TodoRow | undefined> {
      const prisma = await client();
      const row = await prisma.todo.findFirst({ where: { id, owner }, select: { done: true } });
      if (!row) return undefined;
      return prisma.todo.update({ where: { id }, data: { done: !row.done }, select });
    },
  },
};
