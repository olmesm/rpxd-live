/**
 * Total staged-pipeline runner — the shared internal primitive for composing
 * request/dispatch stages (channel pipeline, increment 1).
 *
 * A pipeline is a list of {@link Stage} functions run in order over an
 * accreting context. Each stage either hands a widened context to the next
 * stage or short-circuits with a final output; a thrown/rejected stage and a
 * pipeline that runs off the end without terminating both route through the
 * same `onError` seam, so `runPipeline` itself is total for any well-formed
 * `onError` — see {@link runPipeline}.
 *
 * @packageDocumentation
 */

/**
 * The result a {@link Stage} returns: either `{ next }` to pass an (possibly
 * widened) context to the next stage, or `{ done }` to short-circuit the
 * pipeline with a final output.
 *
 * @example
 * ```ts
 * import type { StageResult } from "@rpxd/core";
 * const advance: StageResult<{ n: number }, string> = { next: { n: 1 } };
 * const finish: StageResult<{ n: number }, string> = { done: "result" };
 * ```
 */
export type StageResult<Ctx, Out> = { next: Ctx } | { done: Out };

/**
 * One step of a staged pipeline: given the current context, either advance
 * (`{ next }`) or terminate (`{ done }`). May be sync or async.
 *
 * @example
 * ```ts
 * import type { Stage } from "@rpxd/core";
 * const parseStage: Stage<{ raw: string }, { error: string }> = (ctx) => {
 *   const n = Number(ctx.raw);
 *   return Number.isNaN(n) ? { done: { error: "not a number" } } : { next: { n } };
 * };
 * ```
 */
export type Stage<Ctx, Out> = (ctx: Ctx) => StageResult<Ctx, Out> | Promise<StageResult<Ctx, Out>>;

/**
 * Run `stages` in order over `ctx`, threading each `{ next }` context forward
 * and returning as soon as a stage produces `{ done }`.
 *
 * `runPipeline` is total: it never rejects on account of a stage. If a stage
 * throws (sync) or rejects (async), `onError(err, ctxAtThatStage, stageIndex)`
 * is called and its result is returned in place of running the rest of the
 * pipeline. If every stage runs without ever returning `{ done }` — including
 * an empty `stages` array — that is treated as pipeline misuse: `onError` is
 * called with an `Error` explaining the pipeline did not terminate, at
 * `stageIndex === stages.length`.
 *
 * `onError` itself must not throw — this function makes no attempt to catch
 * it, so a throwing `onError` propagates out of `runPipeline` as a rejection.
 *
 * @example
 * ```ts
 * import { runPipeline, type Stage } from "@rpxd/core";
 *
 * const stages: Stage<{ n: number }, string>[] = [
 *   (ctx) => ({ next: { n: ctx.n + 1 } }),
 *   (ctx) => ({ done: `total:${ctx.n}` }),
 * ];
 *
 * const out = await runPipeline({ n: 0 }, stages, (err) => `error:${String(err)}`);
 * console.log(out); // "total:1"
 * ```
 */
export async function runPipeline<Ctx, Out>(
  ctx: Ctx,
  stages: readonly Stage<Ctx, Out>[],
  onError: (err: unknown, ctx: Ctx, stageIndex: number) => Out | Promise<Out>,
): Promise<Out> {
  let current = ctx;
  for (let i = 0; i < stages.length; i++) {
    const stage = stages[i] as Stage<Ctx, Out>;
    let result: StageResult<Ctx, Out>;
    try {
      result = await stage(current);
    } catch (err) {
      return await onError(err, current, i);
    }
    if ("done" in result) return result.done;
    current = result.next;
  }
  // Ran off the end without a `{ done }` — misuse of the pipeline (a well-formed
  // pipeline always terminates). `stageIndex` is `stages.length` (one past the
  // last stage, or 0 for an empty array) so callers can tell this apart from a
  // specific stage's throw.
  return await onError(
    new Error(`pipeline did not terminate: ran all ${stages.length} stage(s) without { done }`),
    current,
    stages.length,
  );
}
