import { describe, expect, it } from "vitest";
import { runPipeline, type Stage } from "../src/pipeline.ts";

describe("runPipeline", () => {
  it("runs stages in order, threading the accreted context forward", async () => {
    const seen: number[] = [];
    const stages: Stage<{ n: number }, string>[] = [
      (ctx) => {
        seen.push(ctx.n);
        return { next: { n: ctx.n + 1 } };
      },
      (ctx) => {
        seen.push(ctx.n);
        return { next: { n: ctx.n + 1 } };
      },
      (ctx) => {
        seen.push(ctx.n);
        return { done: `final:${ctx.n}` };
      },
    ];
    const out = await runPipeline({ n: 0 }, stages, () => {
      throw new Error("onError must not be called");
    });
    expect(seen).toEqual([0, 1, 2]);
    expect(out).toBe("final:2");
  });

  it("short-circuits on the first { done } and never runs later stages", async () => {
    let laterRan = false;
    const stages: Stage<{ n: number }, string>[] = [
      () => ({ done: "early" }),
      () => {
        laterRan = true;
        return { done: "late" };
      },
    ];
    const out = await runPipeline({ n: 0 }, stages, () => {
      throw new Error("onError must not be called");
    });
    expect(out).toBe("early");
    expect(laterRan).toBe(false);
  });

  it("supports async stages", async () => {
    const stages: Stage<{ n: number }, string>[] = [
      async (ctx) => {
        await Promise.resolve();
        return { next: { n: ctx.n + 1 } };
      },
      async (ctx) => {
        await Promise.resolve();
        return { done: `async:${ctx.n}` };
      },
    ];
    const out = await runPipeline({ n: 0 }, stages, () => {
      throw new Error("onError must not be called");
    });
    expect(out).toBe("async:1");
  });

  it("routes a thrown error to onError with the ctx at that stage and the stage index", async () => {
    const boom = new Error("stage boom");
    const stages: Stage<{ n: number }, string>[] = [
      (ctx) => ({ next: { n: ctx.n + 1 } }),
      () => {
        throw boom;
      },
      () => ({ done: "unreached" }),
    ];
    let captured: { err: unknown; ctx: { n: number }; idx: number } | undefined;
    const out = await runPipeline({ n: 0 }, stages, (err, ctx, stageIndex) => {
      captured = { err, ctx, idx: stageIndex };
      return "handled";
    });
    expect(out).toBe("handled");
    expect(captured?.err).toBe(boom);
    expect(captured?.ctx).toEqual({ n: 1 });
    expect(captured?.idx).toBe(1);
  });

  it("routes a rejected async stage to onError the same way", async () => {
    const boom = new Error("async stage boom");
    const stages: Stage<{ n: number }, string>[] = [
      async () => {
        throw boom;
      },
    ];
    let captured: unknown;
    const out = await runPipeline({ n: 0 }, stages, (err) => {
      captured = err;
      return "handled";
    });
    expect(out).toBe("handled");
    expect(captured).toBe(boom);
  });

  it("never rejects for a stage throw — onError's result is always returned", async () => {
    const stages: Stage<{ n: number }, string>[] = [
      () => {
        throw new Error("boom");
      },
    ];
    await expect(runPipeline({ n: 0 }, stages, () => "recovered")).resolves.toBe("recovered");
  });

  it("propagates a throw from onError itself", async () => {
    const stages: Stage<{ n: number }, string>[] = [
      () => {
        throw new Error("stage boom");
      },
    ];
    await expect(
      runPipeline({ n: 0 }, stages, () => {
        throw new Error("onError boom");
      }),
    ).rejects.toThrow("onError boom");
  });

  it("treats stage exhaustion without a { done } as misuse: onError at stageIndex === stages.length", async () => {
    const stages: Stage<{ n: number }, string>[] = [(ctx) => ({ next: { n: ctx.n + 1 } })];
    let captured: { err: unknown; idx: number } | undefined;
    const out = await runPipeline({ n: 0 }, stages, (err, _ctx, stageIndex) => {
      captured = { err, idx: stageIndex };
      return "fallback";
    });
    expect(out).toBe("fallback");
    expect(captured?.idx).toBe(1);
    expect(captured?.err).toBeInstanceOf(Error);
    expect((captured?.err as Error).message).toMatch(/did not terminate/i);
  });

  it("treats an empty stages array as the non-termination path", async () => {
    let captured: { err: unknown; idx: number } | undefined;
    const out = await runPipeline({ n: 0 }, [], (err, _ctx, stageIndex) => {
      captured = { err, idx: stageIndex };
      return "empty-fallback";
    });
    expect(out).toBe("empty-fallback");
    expect(captured?.idx).toBe(0);
    expect((captured?.err as Error).message).toMatch(/did not terminate/i);
  });
});
