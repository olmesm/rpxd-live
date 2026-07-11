import { describe, expect, it } from "vitest";
import { installShutdownHandlers, runCloseSequence } from "../src/shutdown.ts";

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
