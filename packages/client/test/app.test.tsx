// @vitest-environment jsdom
/**
 * `LiveApp` + the persistent region (ADR 0002 item 13). The layout renders
 * INSIDE `RpxdProvider` but OUTSIDE `key={pathname}`, so it mounts once per app
 * session and survives navigation: its React state keeps painting across page
 * swaps while the page component below it remounts. Driven with react-dom/client
 * + React's `act` under jsdom, navigating via wouter's browser `navigate` the
 * way {@link LiveApp} itself wires it. A hand-built fake connection stands in for
 * the app-lifetime `LiveConnection` (real `LiveStore` so the render props are
 * real); `remount` resolves like the collapsed tier path (ADR item 9).
 */
import { act, useEffect, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { navigate } from "wouter/use-browser-location";
import { LiveApp } from "../src/app.tsx";
import type { AnyConnection, AnyRoute } from "../src/navigation.ts";
import { RpxdProvider, useNav } from "../src/router.tsx";
import { LiveStore } from "../src/store.ts";

// React's `act` requires this flag; jsdom provides `document`/`window`.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** A confirmed primary store so `LivePage` renders content and navigation's `stateReady` resolves. */
function confirmedConn(): AnyConnection & { remount: ReturnType<typeof vi.fn> } {
  const store = new LiveStore<{ n: number }, Record<string, never>>({
    instance: "page",
    meta: {},
    send: () => {},
    requestResync: () => {},
  });
  store.applyEnvelope({ seq: 1, instance: "page", full: { state: { n: 0 }, session: {} } });
  return {
    store,
    setRedirectSink: () => {},
    patchProps: () => {},
    // Collapsed tiers (ADR item 9): every nav remounts over the same connection.
    remount: vi.fn(async () => {}),
    // The settle-marker aggregate (deflake FIX 1): a confirmed connection is
    // settled and never changes here, so LiveApp's marker effect stamps once.
    synced: true,
    subscribeSync: () => () => {},
  } as unknown as AnyConnection & { remount: ReturnType<typeof vi.fn> };
}

const pageRoute = (label: string, path: string): AnyRoute =>
  ({
    $live: true,
    path,
    def: {},
    component: () => <div data-testid="page">{label}</div>,
  }) as unknown as AnyRoute;

// The persistent region under test: counts its own mounts (module-scoped, reset
// per test) and holds a `useState` draft that must survive navigation.
let layoutMounts = 0;
function Layout({ children }: { children?: React.ReactNode }) {
  const [draft, setDraft] = useState("");
  useEffect(() => {
    layoutMounts += 1;
  }, []);
  return (
    <div data-testid="layout">
      <input data-testid="draft" value={draft} onChange={(e) => setDraft(e.target.value)} />
      <span data-testid="draft-echo">{draft}</span>
      {children}
    </div>
  );
}

let container: HTMLDivElement;
let root: Root;

const render = (ui: React.ReactNode) => act(async () => root.render(ui));
const flush = () => act(async () => {});

beforeEach(() => {
  layoutMounts = 0;
  window.history.replaceState(null, "", "/");
  document.documentElement.removeAttribute("data-rpxd-synced");
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

const routeModules = {
  "/": async () => ({ default: pageRoute("HOME", "/") }),
  "/b": async () => ({ default: pageRoute("PAGE-B", "/b") }),
};

describe("LiveApp persistent region (ADR 0002 item 13)", () => {
  it("mounts the layout once across a tier-3 navigation while the page remounts", async () => {
    const conn = confirmedConn();
    await render(
      <LiveApp
        route={pageRoute("HOME", "/")}
        connection={conn}
        routeModules={routeModules}
        layout={Layout}
      />,
    );

    expect(container.querySelector('[data-testid="layout"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="page"]')?.textContent).toBe("HOME");
    expect(layoutMounts).toBe(1);

    // Type a draft into the layout — this is state the persistent region owns.
    await act(async () => {
      const input = container.querySelector('[data-testid="draft"]') as HTMLInputElement;
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set as (
        v: string,
      ) => void;
      setter.call(input, "hello");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(container.querySelector('[data-testid="draft-echo"]')?.textContent).toBe("hello");

    // Tier-3 navigation: a different page pattern. The connection is app-lifetime.
    await act(async () => {
      navigate("/b");
    });
    await flush();

    // The page below the layout remounted…
    expect(container.querySelector('[data-testid="page"]')?.textContent).toBe("PAGE-B");
    // pageRoute is schema-less, so the tier-2/3 gate is false (ADR 0002 §3).
    expect(conn.remount).toHaveBeenCalledWith("/b", {}, expect.any(Object), false);
    // …but the layout did NOT remount, and its draft survived the page swap.
    expect(layoutMounts).toBe(1);
    expect(container.querySelector('[data-testid="draft-echo"]')?.textContent).toBe("hello");
  });

  it("renders the page directly with no layout (layout-less parity, regression)", async () => {
    const conn = confirmedConn();
    await render(
      <LiveApp route={pageRoute("HOME", "/")} connection={conn} routeModules={routeModules} />,
    );
    expect(container.querySelector('[data-testid="layout"]')).toBeNull();
    expect(container.querySelector('[data-testid="page"]')?.textContent).toBe("HOME");

    await act(async () => {
      navigate("/b");
    });
    await flush();
    expect(container.querySelector('[data-testid="page"]')?.textContent).toBe("PAGE-B");
  });
});

describe("useNav().patch URL/wire coherence (finding 3)", () => {
  /**
   * A connection that only records the props handed to `patchProps`. `hasSchema`
   * selects the tier-1 codec gate (ADR 0002 §3): a schema'd route sends the
   * JSON-value record verbatim; a schema-less one sends the URL's string form.
   */
  function recordingConn(hasSchema = true): {
    conn: AnyConnection;
    patched: Record<string, unknown>[];
  } {
    const patched: Record<string, unknown>[] = [];
    const conn = {
      store: undefined,
      hasPropsSchema: hasSchema,
      setRedirectSink: () => {},
      patchProps: (p: Record<string, unknown>) => patched.push(p),
    } as unknown as AnyConnection;
    return { conn, patched };
  }

  function Patcher({ props }: { props: Record<string, unknown> }) {
    const nav = useNav();
    return (
      <button type="button" data-testid="go" onClick={() => nav.patch(props)}>
        go
      </button>
    );
  }

  it("sends the JSON-value record on the wire and encodes it into the URL (round-trip)", async () => {
    window.history.replaceState(null, "", "/board");
    const { conn, patched } = recordingConn();
    await render(
      <RpxdProvider connection={conn}>
        <Patcher props={{ limit: 20, flag: true }} />
      </RpxdProvider>,
    );
    await act(async () => {
      (container.querySelector('[data-testid="go"]') as HTMLButtonElement).click();
    });
    // Wire: the DECODED (typed) record the server validates without decoding.
    expect(patched).toEqual([{ limit: 20, flag: true }]);
    // URL: encoded so a later full GET / popstate decodes back to the SAME values.
    const qs = new URLSearchParams(window.location.search);
    expect(qs.get("limit")).toBe("20");
    expect(qs.get("flag")).toBe("true");
  });

  it("quotes an ambiguous string in the URL so it round-trips as a string, not a number", async () => {
    window.history.replaceState(null, "", "/board");
    const { conn, patched } = recordingConn();
    await render(
      <RpxdProvider connection={conn}>
        <Patcher props={{ v: "20" }} />
      </RpxdProvider>,
    );
    await act(async () => {
      (container.querySelector('[data-testid="go"]') as HTMLButtonElement).click();
    });
    // Wire keeps the string; the URL quotes it so `decodeProps` recovers "20", not 20.
    expect(patched).toEqual([{ v: "20" }]);
    expect(window.location.search).toContain(`v=${encodeURIComponent('"20"')}`);
  });

  it("SCHEMA-LESS: stringifies the wire record to the URL's string form (ADR pledge)", async () => {
    // On a schema-less route the codec must NOT decode, so `nav.patch({ page: 2 })`
    // must NOT put the number 2 on the wire — a schema-less server keeps raw
    // strings, and a later GET of the resulting URL delivers "2". Sending the
    // number would diverge wire from GET (the typeof heisenbug the ADR forbids).
    window.history.replaceState(null, "", "/board");
    const { conn, patched } = recordingConn(false);
    await render(
      <RpxdProvider connection={conn}>
        <Patcher props={{ page: 2, filter: "done" }} />
      </RpxdProvider>,
    );
    await act(async () => {
      (container.querySelector('[data-testid="go"]') as HTMLButtonElement).click();
    });
    // Wire: the string form the URL round-tripped to (what a schema-less GET yields).
    expect(patched).toEqual([{ page: "2", filter: "done" }]);
    // URL: same encoding as the schema'd path — a bare number, a bare string.
    const qs = new URLSearchParams(window.location.search);
    expect(qs.get("page")).toBe("2");
    expect(qs.get("filter")).toBe("done");
  });
});

describe("LiveApp settle marker (data-rpxd-synced, deflake FIX 1)", () => {
  /**
   * A confirmed connection whose aggregate `synced` value is externally
   * controllable: `setSynced(v)` flips it and fires every `subscribeSync`
   * listener, exactly as a real store snapshot/membership change would.
   */
  function syncableConn(): AnyConnection & { setSynced(v: boolean): void } {
    const store = new LiveStore<{ n: number }, Record<string, never>>({
      instance: "page",
      meta: {},
      send: () => {},
      requestResync: () => {},
    });
    store.applyEnvelope({ seq: 1, instance: "page", full: { state: { n: 0 }, session: {} } });
    let synced = true;
    const listeners = new Set<() => void>();
    return {
      store,
      setRedirectSink: () => {},
      patchProps: () => {},
      remount: vi.fn(async () => {}),
      get synced() {
        return synced;
      },
      subscribeSync(cb: () => void) {
        listeners.add(cb);
        return () => {
          listeners.delete(cb);
        };
      },
      setSynced(v: boolean) {
        synced = v;
        for (const l of listeners) l();
      },
    } as unknown as AnyConnection & { setSynced(v: boolean): void };
  }

  const hasMarker = () => document.documentElement.hasAttribute("data-rpxd-synced");

  it("stamps <html> when synced, removes it while unsettled, restamps at settle", async () => {
    const conn = syncableConn();
    await render(
      <LiveApp route={pageRoute("HOME", "/")} connection={conn} routeModules={routeModules} />,
    );
    // Settled at mount → marker present.
    expect(hasMarker()).toBe(true);

    // An in-flight rpc unsettles the aggregate → marker removed.
    await act(async () => conn.setSynced(false));
    expect(hasMarker()).toBe(false);

    // Ack re-settles → marker restamped (the AFTER-action settle-wait).
    await act(async () => conn.setSynced(true));
    expect(hasMarker()).toBe(true);
  });

  it("removes the marker when the app unmounts", async () => {
    const conn = syncableConn();
    await render(
      <LiveApp route={pageRoute("HOME", "/")} connection={conn} routeModules={routeModules} />,
    );
    expect(hasMarker()).toBe(true);
    await act(async () => root.unmount());
    expect(hasMarker()).toBe(false);
  });
});
