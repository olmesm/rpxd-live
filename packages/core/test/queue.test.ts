import { describe, expect, it, vi } from "vitest";
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

  describe("backlog warning (warnAt/onWarn)", () => {
    it("never warns when no opts are passed", async () => {
      const q = new SerialQueue();
      for (let i = 0; i < 10; i++) {
        void q.run(async () => {
          await tick();
        });
      }
      await q.idle();
      // No onWarn to have called — this test just pins that unbounded use
      // (no opts) never throws or otherwise misbehaves under depth.
      expect(q.size).toBe(0);
    });

    it("calls onWarn once when depth crosses warnAt", async () => {
      const onWarn = vi.fn();
      const q = new SerialQueue({ warnAt: 3, onWarn });
      // #size increments synchronously inside run() (queue.ts), independent of
      // when the task itself executes — so depth crosses warnAt as soon as
      // the 3rd run() call happens, before any of them have run.
      const p1 = q.run(() => tick());
      const p2 = q.run(() => tick());
      const p3 = q.run(() => tick()); // size hits 3 here — crosses warnAt
      expect(onWarn).toHaveBeenCalledTimes(1);
      // Backlog stays >= warnAt — no repeat warning for the same episode.
      const p4 = q.run(() => tick());
      const p5 = q.run(() => tick());
      expect(onWarn).toHaveBeenCalledTimes(1);
      await Promise.all([p1, p2, p3, p4, p5]);
    });

    it("re-arms after draining below warnAt, so a new episode warns again", async () => {
      const onWarn = vi.fn();
      const q = new SerialQueue({ warnAt: 2, onWarn });
      const p1 = q.run(() => tick());
      const p2 = q.run(() => tick());
      expect(onWarn).toHaveBeenCalledTimes(1);
      await Promise.all([p1, p2]);
      await q.idle(); // fully drained — below warnAt, episode clears
      const p3 = q.run(() => tick());
      const p4 = q.run(() => tick());
      expect(onWarn).toHaveBeenCalledTimes(2);
      await Promise.all([p3, p4]);
    });
  });
});
