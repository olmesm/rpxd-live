// @vitest-environment jsdom
/**
 * `<LiveSlot>` (ADR 0002 item 10) — prop-addressed live components + identity-
 * flap detection. Rendered with react-dom/client + React's `act` under jsdom
 * (the lightest DOM path already reachable in the workspace; jsdom + react-dom
 * are devDeps of @rpxd/client added for this file). A hand-built fake connection
 * implements `mountSlot`/`patchProps`/`release` and drives the slot's real
 * {@link LiveStore} so the confirmed-state gate and optimistic surface are real.
 */
import { type LiveRoute, type RenderProps, redirect } from "@rpxd/core";
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type EventSourceLike, LiveConnection, type SlotHandle } from "../src/connection.ts";
import { buildHref, fillPattern, RpxdProvider } from "../src/router.tsx";
import { LiveSlot } from "../src/slot.tsx";
import { LiveStore } from "../src/store.ts";

// React's `act` requires this flag; jsdom provides `document`.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type ChatState = { text: string };

/** A minimal live object — no fluent chain needed; `<LiveSlot>` only reads path/def/component. */
function chatLive(): LiveRoute<
  ChatState,
  "/chat/$room",
  Record<string, never>,
  (p: RenderProps<ChatState, Record<string, never>, Record<string, never>>) => unknown,
  Record<string, unknown>
> {
  return {
    $live: true,
    path: "/chat/$room",
    def: { setup: () => ({ text: "" }) },
    component: ({ state }) => <div data-testid="chat">{(state as ChatState).text}</div>,
    props: undefined,
  };
}

interface MountRecord {
  id: string;
  props: Record<string, unknown>;
  meta: unknown;
  released: boolean;
  handle: SlotHandle<ChatState, Record<string, never>>;
  denyFn?: (loc: string) => void;
  confirm(): void;
  fireDeny(loc: string): void;
  resolve(): void;
}

/** Fake connection: records every mount and lets a test resolve/confirm/deny it. */
class FakeConnection {
  readonly mounts: MountRecord[] = [];
  readonly events: string[] = [];
  deferred = false;
  rejectNextWith: string | null = null;

  mountSlot(
    id: string,
    props: Record<string, unknown>,
    opts: { meta?: unknown } = {},
  ): Promise<SlotHandle<ChatState, Record<string, never>>> {
    this.events.push(`mount:${id}`);
    if (this.rejectNextWith) {
      const loc = this.rejectNextWith;
      this.rejectNextWith = null;
      return Promise.reject(redirect(loc));
    }
    const store = new LiveStore<ChatState, Record<string, never>>({
      instance: id,
      meta: {},
      send: () => {},
      requestResync: () => {},
    });
    const rec: MountRecord = {
      id,
      props,
      meta: opts.meta,
      released: false,
      confirm: () =>
        store.applyEnvelope({
          seq: 1,
          instance: id,
          full: { state: { text: `hi-${id}` }, session: {} },
        }),
      fireDeny: (loc) => rec.denyFn?.(loc),
      resolve: () => {},
      handle: {
        store,
        instance: id,
        path: id,
        patchProps: vi.fn(),
        release: vi.fn(() => {
          rec.released = true;
          this.events.push(`release:${id}`);
        }),
        onDeny: (fn) => {
          rec.denyFn = fn;
        },
      },
    };
    this.mounts.push(rec);
    if (this.deferred) {
      return new Promise((res) => {
        rec.resolve = () => res(rec.handle);
      });
    }
    return Promise.resolve(rec.handle);
  }

  /** Instances mounted but never released — the count that must settle to 1. */
  netLive(): number {
    return this.mounts.filter((m) => !m.released).length;
  }
}

let container: HTMLDivElement;
let root: Root;

async function render(ui: React.ReactNode): Promise<void> {
  await act(async () => {
    root.render(ui);
  });
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
  vi.useRealTimers();
});

function slot(
  conn: FakeConnection,
  params: { room: string },
  extra: { props?: Record<string, unknown>; onDeny?: (l: string) => void } = {},
) {
  const Chat = chatLive();
  return (
    <RpxdProvider connection={conn as never}>
      <LiveSlot
        of={Chat}
        params={params}
        props={extra.props}
        fallback={<span>loading</span>}
        onDeny={extra.onDeny}
      />
    </RpxdProvider>
  );
}

describe("fillPattern", () => {
  it("fills, encodes per-segment, and needs no leading slash", () => {
    expect(fillPattern("/chat/$room", { room: "main" })).toBe("/chat/main");
    expect(fillPattern("/org/$orgId/board", { orgId: "a/c me" })).toBe("/org/a%2Fc%20me/board");
    expect(fillPattern("chat/$room", { room: "x" })).toBe("chat/x");
    expect(fillPattern("/static/path")).toBe("/static/path");
  });

  it("throws a clear error on a missing param", () => {
    expect(() => fillPattern("/chat/$room", {})).toThrow(/Missing path param "room"/);
  });

  it("buildHref still delegates correctly (regression)", () => {
    expect(buildHref("/org/$orgId/board", { orgId: "42" }, { filter: "done" })).toBe(
      "/org/42/board?filter=done",
    );
  });
});

describe("<LiveSlot> render lifecycle", () => {
  it("renders fallback before the snapshot, then the component after confirm", async () => {
    const conn = new FakeConnection();
    await render(slot(conn, { room: "a" }));
    // Handle resolved but store not confirmed → fallback.
    expect(container.textContent).toBe("loading");
    expect(conn.mounts).toHaveLength(1);

    await act(async () => {
      conn.mounts[0]?.confirm();
    });
    expect(container.querySelector('[data-testid="chat"]')?.textContent).toBe("hi-/chat/a");
  });

  it("two same-identity <LiveSlot>s both render live state (finding 4)", async () => {
    // Two slots with the SAME identity on one page share the server instance but
    // each keeps its own store — the pre-fix single-store map overwrote the first
    // with the second, leaving the first stuck on `fallback` forever.
    const conn = new FakeConnection();
    const Chat = chatLive();
    await render(
      <RpxdProvider connection={conn as never}>
        <div data-testid="one">
          <LiveSlot of={Chat} params={{ room: "main" }} fallback={<span>loading</span>} />
        </div>
        <div data-testid="two">
          <LiveSlot of={Chat} params={{ room: "main" }} fallback={<span>loading</span>} />
        </div>
      </RpxdProvider>,
    );
    // Both slots mounted the same identity path, each with its own store/handle.
    expect(conn.mounts).toHaveLength(2);
    expect(conn.mounts.every((m) => m.id === "/chat/main")).toBe(true);

    await act(async () => {
      for (const m of conn.mounts) m.confirm();
    });
    // Neither is stuck on fallback — both render the confirmed live state.
    const one = container.querySelector('[data-testid="one"]');
    const two = container.querySelector('[data-testid="two"]');
    expect(one?.querySelector('[data-testid="chat"]')?.textContent).toBe("hi-/chat/main");
    expect(two?.querySelector('[data-testid="chat"]')?.textContent).toBe("hi-/chat/main");
  });

  it("releases on unmount", async () => {
    const conn = new FakeConnection();
    await render(slot(conn, { room: "a" }));
    await act(async () => {
      conn.mounts[0]?.confirm();
    });
    await act(async () => {
      root.render(<RpxdProvider connection={conn as never}>{null}</RpxdProvider>);
    });
    expect(conn.mounts[0]?.released).toBe(true);
    expect(conn.netLive()).toBe(0);
  });
});

describe("<LiveSlot> identity", () => {
  it("settles on exactly one live mount under StrictMode double-invoke", async () => {
    const conn = new FakeConnection();
    const Chat = chatLive();
    await render(
      <StrictMode>
        <RpxdProvider connection={conn as never}>
          <LiveSlot of={Chat} params={{ room: "a" }} fallback={<span>loading</span>} />
        </RpxdProvider>
      </StrictMode>,
    );
    // StrictMode mounts the effect twice; the superseded mount releases itself.
    expect(conn.mounts.length).toBeGreaterThanOrEqual(2);
    expect(conn.netLive()).toBe(1);
  });

  it("params change → old released before new mounted (ordered)", async () => {
    const conn = new FakeConnection();
    await render(slot(conn, { room: "a" }));
    await act(async () => {
      conn.mounts[0]?.confirm();
    });
    await render(slot(conn, { room: "b" }));

    const releaseA = conn.events.indexOf("release:/chat/a");
    const mountB = conn.events.indexOf("mount:/chat/b");
    expect(releaseA).toBeGreaterThanOrEqual(0);
    expect(mountB).toBeGreaterThanOrEqual(0);
    expect(releaseA).toBeLessThan(mountB);
    expect(conn.netLive()).toBe(1);
  });

  it("a stale in-flight mount that resolves after supersession releases itself", async () => {
    const conn = new FakeConnection();
    conn.deferred = true;
    await render(slot(conn, { room: "a" }));
    await render(slot(conn, { room: "b" })); // supersede before "a" resolves

    // Resolve the stale mount last — it must release itself, not bind.
    await act(async () => {
      conn.mounts[1]?.resolve(); // b (current)
      conn.mounts[0]?.resolve(); // a (stale)
    });
    expect(conn.mounts[0]?.released).toBe(true);
    expect(conn.mounts[1]?.released).toBe(false);
    expect(conn.netLive()).toBe(1);

    await act(async () => {
      conn.mounts[1]?.confirm();
    });
    expect(container.querySelector('[data-testid="chat"]')?.textContent).toBe("hi-/chat/b");
  });
});

describe("<LiveSlot> props diffing", () => {
  it("coalesces three same-tick prop changes into one patchProps with the final value", async () => {
    const conn = new FakeConnection();
    await render(slot(conn, { room: "a" }, { props: { n: 0 } }));
    await act(async () => {
      conn.mounts[0]?.confirm();
    });
    const patch = conn.mounts[0]?.handle.patchProps as ReturnType<typeof vi.fn>;
    patch.mockClear();

    await act(async () => {
      root.render(slot(conn, { room: "a" }, { props: { n: 1 } }));
      root.render(slot(conn, { room: "a" }, { props: { n: 2 } }));
      root.render(slot(conn, { room: "a" }, { props: { n: 3 } }));
    });

    expect(patch).toHaveBeenCalledTimes(1);
    expect(patch).toHaveBeenCalledWith({ n: 3 });
  });

  it("does not patch when the serialized props are unchanged", async () => {
    const conn = new FakeConnection();
    await render(slot(conn, { room: "a" }, { props: { n: 1 } }));
    await act(async () => {
      conn.mounts[0]?.confirm();
    });
    const patch = conn.mounts[0]?.handle.patchProps as ReturnType<typeof vi.fn>;
    patch.mockClear();
    // New object identity, same content.
    await render(slot(conn, { room: "a" }, { props: { n: 1 } }));
    expect(patch).not.toHaveBeenCalled();
  });
});

describe("<LiveSlot> denials", () => {
  it("mount deny → onDeny(location) + fallback stays", async () => {
    const conn = new FakeConnection();
    conn.rejectNextWith = "/login";
    const onDeny = vi.fn();
    await render(slot(conn, { room: "a" }, { onDeny }));
    expect(onDeny).toHaveBeenCalledWith("/login");
    expect(container.textContent).toBe("loading");
    expect(conn.netLive()).toBe(0);
  });

  it("runtime deny (handle.onDeny) → releases, falls back, calls onDeny", async () => {
    const conn = new FakeConnection();
    const onDeny = vi.fn();
    await render(slot(conn, { room: "a" }, { onDeny }));
    await act(async () => {
      conn.mounts[0]?.confirm();
    });
    expect(container.querySelector('[data-testid="chat"]')).not.toBeNull();

    await act(async () => {
      conn.mounts[0]?.fireDeny("/login");
    });
    expect(onDeny).toHaveBeenCalledWith("/login");
    expect(container.textContent).toBe("loading");
    expect(conn.mounts[0]?.released).toBe(true);
  });
});

/** Minimal injectable EventSource for the real-connection integration test. */
class FakeES implements EventSourceLike {
  static instances: FakeES[] = [];
  listeners = new Map<string, ((e: { data: string }) => void)[]>();
  readyState = 0;
  constructor(public url: string) {
    FakeES.instances.push(this);
  }
  addEventListener(type: string, fn: (e: { data: string }) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(fn);
    this.listeners.set(type, list);
  }
  emit(type: string, data = ""): void {
    for (const fn of this.listeners.get(type) ?? []) fn({ data });
  }
  close(): void {}
  static last(): FakeES {
    return FakeES.instances.at(-1) as FakeES;
  }
}

/** Flush the async mount/release microtask chain inside `act`. */
async function settle(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 12; i++) await Promise.resolve();
  });
}

describe("<LiveSlot> + LiveConnection pair cancellation (ADR 0002 item 12)", () => {
  it("(g) keyed page-subtree remount of the same slot identity → net zero mounts/releases on the wire", async () => {
    FakeES.instances = [];
    const control: Record<string, unknown>[] = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      if (String(url).endsWith("/__rpxd/control")) {
        if (body) control.push(body);
        // Same path → same instance id (a warm re-mount would resolve identically).
        if (body?.type === "mount") return Response.json({ instance: "inst/chat/main", seq: 1 });
        return new Response(null, { status: 204 });
      }
      return new Response(null, { status: 202 });
    }) as typeof fetch;
    const conn = new LiveConnection({
      instance: "page",
      fetchImpl,
      eventSource: (u) => new FakeES(u),
    });
    conn.connect();
    FakeES.last().emit("open");

    const Chat = chatLive();
    const page = (k: string) => (
      <RpxdProvider connection={conn as never}>
        <div key={k}>
          <LiveSlot
            of={Chat}
            params={{ room: "main" }}
            props={{ topic: "x" }}
            fallback={<span>loading</span>}
          />
        </div>
      </RpxdProvider>
    );

    // Mount page A's slot and confirm its state.
    await render(page("a"));
    await settle();
    await act(async () => {
      FakeES.last().emit(
        "env",
        JSON.stringify({
          seq: 1,
          instance: "inst/chat/main",
          full: { state: { text: "alive" }, session: {} },
        }),
      );
    });
    expect(container.querySelector('[data-testid="chat"]')?.textContent).toBe("alive");
    const typed = (t: string) => control.filter((b) => b?.type === t);
    expect(typed("mount")).toHaveLength(1);
    expect(typed("release")).toHaveLength(0);

    // A keyed page swap remounts the SAME slot identity in one commit: the old
    // slot's release and the new slot's mount land in the same tick and cancel.
    await act(async () => {
      root.render(page("b"));
    });
    await settle();

    // Net zero: no second mount, no release, no url (props unchanged). The slot
    // survives the remount — same instance, still showing its confirmed state.
    expect(typed("mount")).toHaveLength(1);
    expect(typed("mount-batch")).toHaveLength(0);
    expect(typed("release")).toHaveLength(0);
    expect(typed("url")).toHaveLength(0);
    expect(container.querySelector('[data-testid="chat"]')?.textContent).toBe("alive");
    conn.close();
  });
});

describe("<LiveSlot> SSR-safety (ADR 0002 item 13)", () => {
  it("renders its fallback (no crash) when there is no connection context — the server render path", async () => {
    // A layout hosts `<LiveSlot>`s and SSRs with no ConnectionContext
    // (`useContext` → null server-side, and effects never run in
    // renderToStaticMarkup). It must render `fallback`, not throw.
    const { renderToStaticMarkup } = await import("react-dom/server");
    const Chat = chatLive();
    const html = renderToStaticMarkup(
      <LiveSlot of={Chat} params={{ room: "main" }} fallback={<span>loading</span>} />,
    );
    expect(html).toBe("<span>loading</span>");
  });
});

describe("<LiveSlot> flap detection", () => {
  it("logs once when identity changes more than the threshold within a second", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(0);
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const conn = new FakeConnection();

    // 8 identity changes across 800ms (< 1s window) — well past the 5 threshold.
    for (let i = 0; i < 8; i++) {
      vi.setSystemTime(i * 100);
      await render(slot(conn, { room: `r${i}` }));
    }

    const flapLogs = err.mock.calls.filter((c) => String(c[0]).includes("remounting rapidly"));
    expect(flapLogs).toHaveLength(1);
    expect(String(flapLogs[0]?.[0])).toContain('of="/chat/$room"');
    expect(String(flapLogs[0]?.[0])).toContain("room");
    // Mounts still proceed despite the warning.
    expect(conn.mounts.length).toBeGreaterThanOrEqual(8);
    err.mockRestore();
  });
});
