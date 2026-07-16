import { redirect } from "@rpxd/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type AnyConnection,
  type AnyRoute,
  type CurrentPage,
  claimNavigationTicket,
  type NavigationIo,
  performNavigation,
  popstateSearchPatch,
} from "../src/navigation.ts";
import { searchOnlyChange } from "../src/router.tsx";

const flushTick = () => new Promise<void>((r) => setTimeout(r, 0));

function fakeConn() {
  return {
    store: { confirmed: {} as unknown, subscribe: () => () => {} },
    remount: vi.fn(async (_p: string, _s: Record<string, string>, _m?: unknown) => {}),
    close: vi.fn(),
  };
}
const asConn = (c: ReturnType<typeof fakeConn>) => c as unknown as AnyConnection;

const routeB = { path: "/b", def: {}, component: () => null } as unknown as AnyRoute;
const routeT = { path: "/t/$id", def: {}, component: () => null } as unknown as AnyRoute;

function makeIo(overrides: Partial<NavigationIo> = {}) {
  const commits: { page: CurrentPage }[] = [];
  const hardLoads: string[] = [];
  const softNavs: string[] = [];
  const conn = fakeConn();
  const io: NavigationIo = {
    pathname: "/b",
    search: {},
    my: 1,
    ticket: { current: 1 },
    conn: asConn(conn),
    routeModules: {
      "/b": async () => ({ default: routeB }),
      "/t/$id": async () => ({ default: routeT }),
    },
    commit: (page) => commits.push({ page }),
    softNavigate: (loc) => softNavs.push(loc),
    hardLoad: (url) => hardLoads.push(url),
    ...overrides,
  };
  return { io, commits, hardLoads, softNavs, conn };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("claimNavigationTicket (§7)", () => {
  it("returns a fresh ticket for a path change", () => {
    const ticket = { current: 0 };
    expect(claimNavigationTicket(ticket, "/b", "/a")).toBe(1);
    expect(ticket.current).toBe(1);
  });

  it("claims the ticket even when the target is the page on screen", () => {
    const ticket = { current: 3 };
    // Back to the current page: nothing to mount…
    expect(claimNavigationTicket(ticket, "/a", "/a")).toBeNull();
    // …but the claim must still invalidate any in-flight forward mount.
    expect(ticket.current).toBe(4);
  });

  it("a back-to-current claim invalidates an in-flight forward remount", async () => {
    const ticket = { current: 0 };
    const my = claimNavigationTicket(ticket, "/b", "/a") as number;
    let resolveRemount: () => void = () => {};
    const conn = fakeConn();
    conn.remount.mockImplementation(
      () =>
        new Promise<void>((res) => {
          resolveRemount = res;
        }),
    );
    const { io, commits } = makeIo({ my, ticket, conn: asConn(conn) });
    const nav = performNavigation(io);
    await flushTick(); // route module resolved; remount still in flight

    // The user navigates back to the page already on screen…
    expect(claimNavigationTicket(ticket, "/a", "/a")).toBeNull();
    resolveRemount();
    await nav;

    // …so the superseded navigation must not commit (wrong-page flash). The
    // connection is app-lifetime — nothing is closed; the superseded remount
    // self-releases its own instance (connection.ts #remountRunId).
    expect(commits).toEqual([]);
    expect(conn.close).not.toHaveBeenCalled();
  });
});

describe("performNavigation fallbacks (§7)", () => {
  it("hard-loads the full target URL — search string included", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { io, hardLoads, conn } = makeIo({ search: { q: "1" } });
    conn.remount.mockRejectedValue(new Error("boom"));
    await performNavigation(io);
    expect(hardLoads).toEqual(["/b?q=1"]);
  });

  it("a stale failure must not clobber a newer navigation with a hard load", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const ticket = { current: 1 };
    const { io, hardLoads, conn } = makeIo({ ticket });
    conn.remount.mockImplementation(async () => {
      ticket.current++; // a newer navigation claimed the ticket meanwhile
      throw new Error("boom");
    });
    await performNavigation(io);
    expect(hardLoads).toEqual([]);
  });

  it("an unmatched pathname hard-loads with the query intact", async () => {
    const { io, hardLoads, commits } = makeIo({ pathname: "/nope", search: { q: "1" } });
    await performNavigation(io);
    expect(hardLoads).toEqual(["/nope?q=1"]);
    expect(commits).toEqual([]);
  });
});

describe("performNavigation collapsed tiers + redirects (§7, §10, ADR 0002 item 9)", () => {
  it("tier 2: same-pattern nav remounts over the connection with the route meta", async () => {
    const { io, commits, conn } = makeIo({ pathname: "/t/2", search: { q: "x" } });
    await performNavigation(io);
    // The collapsed path threads the new route's rpc meta so the swapped
    // primary store validates/optimistics with it.
    expect(conn.remount).toHaveBeenCalledWith("/t/2", { q: "x" }, expect.any(Object));
    expect(commits).toEqual([{ page: { pathname: "/t/2", route: routeT, conn: io.conn } }]);
  });

  it("tier 3: a different pattern rides the SAME connection (no fresh mount, no close)", async () => {
    const { io, commits, conn } = makeIo({ pathname: "/b" });
    await performNavigation(io);
    // Both tiers collapse to remount — the connection is app-lifetime.
    expect(conn.remount).toHaveBeenCalledWith("/b", {}, expect.any(Object));
    expect(conn.close).not.toHaveBeenCalled();
    expect(commits).toEqual([{ page: { pathname: "/b", route: routeB, conn: io.conn } }]);
  });

  it("a remount redirect soft-navigates instead of hard-loading", async () => {
    const { io, softNavs, hardLoads, conn } = makeIo();
    conn.remount.mockRejectedValue(redirect("/login"));
    await performNavigation(io);
    expect(softNavs).toEqual(["/login"]);
    expect(hardLoads).toEqual([]);
  });

  it("a stale redirect is dropped", async () => {
    const ticket = { current: 1 };
    const { io, softNavs, conn } = makeIo({ ticket });
    conn.remount.mockImplementation(async () => {
      ticket.current++;
      throw redirect("/login");
    });
    await performNavigation(io);
    expect(softNavs).toEqual([]);
  });

  it("latest-wins across collapsed tiers: only the final navigation commits", async () => {
    // A tier-3 (→/b) whose remount resolves LATE, superseded by a tier-2 (→/t/9)
    // that resolves immediately — one shared app-lifetime connection.
    const ticket = { current: 0 };
    const conn = fakeConn();
    let resolveFirst: () => void = () => {};
    conn.remount.mockImplementationOnce(
      () => new Promise<void>((res) => (resolveFirst = res)), // tier 3 pending
    );
    const commits: { page: CurrentPage }[] = [];
    const base = {
      conn: asConn(conn),
      ticket,
      routeModules: {
        "/b": async () => ({ default: routeB }),
        "/t/$id": async () => ({ default: routeT }),
      },
      commit: (page: CurrentPage) => commits.push({ page }),
      softNavigate: () => {},
      hardLoad: () => {},
    };

    const my1 = claimNavigationTicket(ticket, "/b", "/a") as number;
    const first = performNavigation({ ...base, pathname: "/b", search: {}, my: my1 });
    await flushTick();
    const my2 = claimNavigationTicket(ticket, "/t/9", "/b") as number;
    const second = performNavigation({ ...base, pathname: "/t/9", search: {}, my: my2 });
    await second;
    resolveFirst();
    await first;

    // Only the winner committed; the superseded navigation dropped its commit.
    expect(commits).toEqual([{ page: { pathname: "/t/9", route: routeT, conn: asConn(conn) } }]);
  });
});

describe("search-only navigation (§7 tier 1)", () => {
  it("returns the target search for a same-path href with a different query", () => {
    expect(searchOnlyChange("/b?filter=done", "/b", "?filter=all")).toEqual({ filter: "done" });
    expect(searchOnlyChange("/b?filter=done", "/b", "")).toEqual({ filter: "done" });
  });

  it("returns {} when the href clears the search", () => {
    expect(searchOnlyChange("/b", "/b", "?filter=all")).toEqual({});
  });

  it("returns null for a pathname change — the app shell owns those", () => {
    expect(searchOnlyChange("/c?f=1", "/b", "?f=1")).toBeNull();
    expect(searchOnlyChange("/c", "/b", "")).toBeNull();
  });

  it("returns null when nothing changed (order-insensitive)", () => {
    expect(searchOnlyChange("/b?f=1", "/b", "?f=1")).toBeNull();
    expect(searchOnlyChange("/b?a=1&b=2", "/b", "?b=2&a=1")).toBeNull();
    expect(searchOnlyChange("/b", "/b", "")).toBeNull();
  });
});

describe("popstate search reconciliation (§7)", () => {
  it("yields the full search record when the pathname is unchanged", () => {
    expect(popstateSearchPatch("/b", "?filter=done&x=1", "/b")).toEqual({
      filter: "done",
      x: "1",
    });
    expect(popstateSearchPatch("/b", "", "/b")).toEqual({});
  });

  it("defers to the location effect on a pathname change", () => {
    expect(popstateSearchPatch("/c", "?f=1", "/b")).toBeNull();
  });
});
