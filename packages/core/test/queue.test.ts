import { describe, expect, it } from "vitest";
import { SerialQueue } from "../src/queue.ts";

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

describe("SerialQueue", () => {
  it("runs tasks strictly in FIFO order", async () => {
    const q = new SerialQueue();
    const log: number[] = [];
    const slow = q.run(async () => {
      await tick();
      log.push(1);
    });
    const fast = q.run(() => {
      log.push(2);
    });
    await Promise.all([slow, fast]);
    expect(log).toEqual([1, 2]);
  });

  it("does not poison the queue on rejection", async () => {
    const q = new SerialQueue();
    const failed = q.run(() => {
      throw new Error("boom");
    });
    const after = q.run(() => "ok");
    await expect(failed).rejects.toThrow("boom");
    await expect(after).resolves.toBe("ok");
  });

  it("idle() resolves after queued work, including work queued mid-flight", async () => {
    const q = new SerialQueue();
    const log: string[] = [];
    void q.run(async () => {
      log.push("a");
      void q.run(() => {
        log.push("b");
      });
    });
    await q.idle();
    expect(log).toEqual(["a", "b"]);
  });
});
