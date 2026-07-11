import type { RpxdDiagnostic } from "@rpxd/core";
import { afterEach, describe, expect, it } from "vitest";
import {
  installShutdownHandlers,
  installUnhandledRejectionGuard,
  makeUnhandledRejectionHandler,
  runCloseSequence,
} from "../src/shutdown.ts";

describe("runCloseSequence", () => {
  it("flushes snapshots before closing storage, with userland cleanup between", async () => {
    const order: string[] = [];
    await runCloseSequence({
      stop: () => void order.push("stop"),
      dispose: async () => void order.push("dispose"),
      onShutdown: async () => void order.push("onShutdown"),
      closeStorage: () => void order.push("closeStorage"),
    });
    // dispose (snapshot flush) MUST precede closeStorage, or snapshots are lost.
    expect(order).toEqual(["stop", "dispose", "onShutdown", "closeStorage"]);
  });

  it("tolerates absent optional steps", async () => {
    const order: string[] = [];
    await runCloseSequence({
      stop: () => void order.push("stop"),
      dispose: () => void order.push("dispose"),
    });
    expect(order).toEqual(["stop", "dispose"]);
  });
});

/** Drive a signal through the real emitter, then deregister so tests don't leak handlers. */
async function fire(signal: "SIGTERM" | "SIGINT", install: () => () => void): Promise<void> {
  const remove = install();
  process.emit(signal as NodeJS.Signals);
  await new Promise((r) => setTimeout(r, 5)); // let the async handler run
  remove();
}

describe("installShutdownHandlers", () => {
  it("runs close() then exits 0 on SIGTERM", async () => {
    let closed = false;
    let code: number | undefined;
    await fire("SIGTERM", () =>
      installShutdownHandlers(
        async () => {
          closed = true;
        },
        { exit: (c) => (code = c) },
      ),
    );
    expect(closed).toBe(true);
    expect(code).toBe(0);
  });

  it("force-exits 1 on a second signal while already shutting down", async () => {
    const codes: number[] = [];
    let release: () => void = () => {};
    const remove = installShutdownHandlers(
      () => new Promise<void>((r) => (release = r)), // close() hangs until released
      { exit: (c) => codes.push(c) },
    );
    process.emit("SIGTERM" as NodeJS.Signals); // starts shutdown, close() pending
    await new Promise((r) => setTimeout(r, 5));
    process.emit("SIGINT" as NodeJS.Signals); // impatient second signal → force
    await new Promise((r) => setTimeout(r, 5));
    expect(codes).toContain(1);
    release();
    remove();
  });

  it("exits 1 if close() exceeds the timeout", async () => {
    const codes: number[] = [];
    await fire("SIGTERM", () =>
      installShutdownHandlers(() => new Promise<void>(() => {}), {
        exit: (c) => codes.push(c),
        timeoutMs: 10,
      }),
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(codes).toContain(1); // timeout backstop fired
  });

  it("exits 1 if close() throws", async () => {
    let code: number | undefined;
    await fire("SIGTERM", () =>
      installShutdownHandlers(
        async () => {
          throw new Error("dispose blew up");
        },
        { exit: (c) => (code = c) },
      ),
    );
    expect(code).toBe(1);
  });
});

describe("makeUnhandledRejectionHandler", () => {
  const originalNodeEnv = process.env.NODE_ENV;
  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
  });

  it("reports the rejection through the diagnostic sink", () => {
    process.env.NODE_ENV = "production"; // don't let the re-throw escape the test
    const emitted: RpxdDiagnostic[] = [];
    const reason = new Error("detached");
    makeUnhandledRejectionHandler((d) => emitted.push(d))(reason);
    expect(emitted).toEqual([
      { category: "request", type: "unhandled-rejection", level: "error", error: reason },
    ]);
  });

  it("re-throws in development so the bug surfaces loudly", () => {
    process.env.NODE_ENV = "development";
    const reason = new Error("detached");
    expect(() => makeUnhandledRejectionHandler(() => {})(reason)).toThrow(reason);
  });

  it("wraps a non-Error reason in development before re-throwing", () => {
    process.env.NODE_ENV = "development";
    expect(() => makeUnhandledRejectionHandler(() => {})("boom")).toThrow("boom");
  });

  it("does not throw in production — a detached rejection shouldn't take the server down", () => {
    process.env.NODE_ENV = "production";
    const reason = new Error("detached");
    expect(() => makeUnhandledRejectionHandler(() => {})(reason)).not.toThrow();
  });
});

describe("installUnhandledRejectionGuard", () => {
  afterEach(() => {
    process.removeAllListeners("unhandledRejection");
  });

  // The install flag is a module-level singleton (idempotent across HMR/dev
  // restarts), so both assertions live in one test — a second, separate test
  // could not observe "already installed" without also observing "installed".
  it("installs the listener once; a repeated call adds no second listener", () => {
    const before = process.listenerCount("unhandledRejection");
    installUnhandledRejectionGuard(() => {});
    expect(process.listenerCount("unhandledRejection")).toBe(before + 1);
    installUnhandledRejectionGuard(() => {}); // no-op — already installed
    expect(process.listenerCount("unhandledRejection")).toBe(before + 1);
  });
});
