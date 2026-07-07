import { live } from "@rpxd/core";
import type { ReactNode } from "react";

const INITIAL = "# rpxd doc\nrendered with a *server-only* markdown module";

/**
 * RSC fields demo (§16, experimental `rsc: true`): the markdown module is
 * dynamic-imported inside server code only — its output rides state as an
 * opaque field and the client renders `{state.body}` without ever shipping
 * the renderer.
 */
export default live("/doc")
  .mount(async () => {
    const [{ rsc }, { renderMarkdown }] = await Promise.all([
      import("@rpxd/rsc"),
      import("../lib/markdown.tsx"),
    ]);
    return { source: INITIAL, body: rsc(renderMarkdown(INITIAL)) as unknown };
  })
  .rpc("append", (r) =>
    r.handler(async ({ text }: { text: string }, ctx) => {
      const [{ rsc }, { renderMarkdown }] = await Promise.all([
        import("@rpxd/rsc"),
        import("../lib/markdown.tsx"),
      ]);
      const source = `${ctx.state.source}\n${text}`;
      ctx.patchState((s) => {
        s.source = source;
        // Patches replace the whole field — React reconciles (§16).
        s.body = rsc(renderMarkdown(source)) as unknown;
      });
    }),
  )
  .render(({ state, rpc }) => (
    <main>
      <h1>rpxd rsc doc</h1>
      <section data-testid="doc">{state.body as ReactNode}</section>
      <button type="button" onClick={() => void rpc.append({ text: "appended *live*" })}>
        Append
      </button>
    </main>
  ));
