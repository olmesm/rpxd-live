import { live } from "@rpxd/core";

/**
 * Streaming demo (§3): a handler grows a string with `s.answer += delta` inside
 * a loop. Each write is one flush, and string-suffix growth compiles to an
 * `append` patch op carrying only the delta (§2) — so a token stream stays
 * O(delta) on the wire, not O(total). Tokens are deterministic (no real LLM) to
 * keep the e2e stable; `stop` aborts mid-stream via `ctx.abort` + `ctx.signal`.
 */
const TOKENS = "the quick brown fox jumps over the lazy dog".split(" ");
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export default live("/stream")
  .setup(() => ({ answer: "", streaming: false }))
  .rpc("generate", (r) =>
    r.handler(async (_payload, ctx) => {
      ctx.patchState((s) => {
        s.answer = "";
        s.streaming = true;
      });
      for (const token of TOKENS) {
        if (ctx.signal.aborted) break;
        await sleep(120);
        ctx.patchState((s) => {
          s.answer += `${token} `; // suffix growth → append op, O(delta) wire
        });
      }
      ctx.patchState((s) => {
        s.streaming = false;
      });
    }),
  )
  .rpc("stop", (r) =>
    r.handler(async (_payload, ctx) => {
      ctx.abort("generate");
    }),
  )
  .render(({ state, rpc }) => (
    <main>
      <h1>rpxd stream</h1>
      <button type="button" data-testid="generate" onClick={() => void rpc.generate({})}>
        Generate
      </button>
      <button type="button" data-testid="stop" onClick={() => void rpc.stop({})}>
        Stop
      </button>
      <p data-testid="answer">{state.answer}</p>
      {state.streaming && <span data-testid="streaming">streaming…</span>}
    </main>
  ));
