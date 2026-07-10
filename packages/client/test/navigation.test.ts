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
    remount: vi.fn(async () => {}),
    close: vi.fn(),
  };
}
const asConn = (c: ReturnType<typeof fakeConn>) => c as unknown as AnyConnection;

const routeB = { path: "/b", def: {}, component: () => null } as unknown as AnyRoute;
const routeT = { path: "/t/$id", def: {}, component: () => null } as unknown as AnyRoute;

function makeIo(overrides: Partial<NavigationIo> = {}) {
  const commits: { page: CurrentPage; closePrevious: boolean }[] = [];
  const hardLoads: string[] = [];
  const softNavs: string[] = [];
  const conn = fakeConn();
  const io: NavigationIo = {
    pathname: "/b",
    search: {},
    my: 1,
    ticket: { current: 1 },
    currentRoutePath: "/a",
    conn: asConn(conn),
    routeModules: {
      "/b": async () => ({ default: routeB }),
      "/t/$id": async () => ({ default: routeT }),
    },
    mount: vi.fn(async () => asConn(fakeConn())),
    commit: (page, closePrevious) => commits.push({ page, closePrevious }),
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

  it("a back-to-current claim invalidates an in-flight forward mount", async () => {
    const ticket = { current: 0 };
    const my = claimNavigationTicket(ticket, "/b", "/a") as number;
    const mounted = fakeConn();
    let resolveMount: (c: AnyConnection) => void = () => {};
    const { io, commits } = makeIo({
      my,
      ticket,
      mount: () =>
        new Promise<AnyConnection>((res) => {
          resolveMount = res;
        }),
    });
    const nav = performNavigation(io);
    await flushTick(); // route module resolved; mount still in flight

    // The user navigates back to the page already on screen…
    expect(claimNavigationTicket(ticket, "/a", "/a")).toBeNull();
    resolveMount(asConn(mounted));
    await nav;

    // …so the superseded mount must not commit (wrong-page flash + remount)
    // and its connection must be closed, not leaked.
    expect(commits).toEqual([]);
    expect(mounted.close).toHaveBeenCalled();
  });
});

describe("performNavigation fallbacks (§7)", () => {
  it("hard-loads the full target URL — search string included", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { io, hardLoads } = makeIo({
      search: { q: "1" },
      mount: async () => {
        throw new Error("boom");
      },
    });
    await performNavigation(io);
    expect(hardLoads).toEqual(["/b?q=1"]);
  });

  it("a stale failure must not clobber a newer navigation with a hard load", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const ticket = { current: 1 };
    const { io, hardLoads } = makeIo({
      ticket,
      mount: async () => {
        ticket.current++; // a newer navigation claimed the ticket meanwhile
        throw new Error("boom");
      },
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

describe("performNavigation tiers + redirects (§7, §10)", () => {
  it("tier 2: same route pattern remounts over the existing connection", async () => {
    const { io, commits, conn } = makeIo({
      pathname: "/t/2",
      search: { q: "x" },
      currentRoutePath: "/t/$id",
    });
    await performNavigation(io);
    expect(conn.remount).toHaveBeenCalledWith("/t/2", { q: "x" });
    expect(commits).toEqual([
      { page: { pathname: "/t/2", route: routeT, conn: io.conn }, closePrevious: false },
    ]);
  });

  it("tier 3: a different pattern mounts a fresh connection and closes the old one", async () => {
    const next = fakeConn();
    const { io, commits } = makeIo({ mount: async () => asConn(next) });
    await performNavigation(io);
    expect(commits).toEqual([
      { page: { pathname: "/b", route: routeB, conn: asConn(next) }, closePrevious: true },
    ]);
  });

  it("a mount redirect soft-navigates instead of hard-loading", async () => {
    const { io, softNavs, hardLoads } = makeIo({
      mount: async () => {
        throw redirect("/login");
      },
    });
    await performNavigation(io);
    expect(softNavs).toEqual(["/login"]);
    expect(hardLoads).toEqual([]);
  });

  it("a stale redirect is dropped", async () => {
    const ticket = { current: 1 };
    const { io, softNavs } = makeIo({
      ticket,
      mount: async () => {
        ticket.current++;
        throw redirect("/login");
      },
    });
    await performNavigation(io);
    expect(softNavs).toEqual([]);
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
