import type { RenderProps } from "@rpxd/client";
import { live } from "@rpxd/core";
import type { Draft } from "immer";
import type { ReactNode } from "react";

interface DocState {
  source: string;
  /** RSC field (§16): opaque on the wire, a rendered subtree at render time. */
  body: unknown;
}

const INITIAL = "# rpxd doc\nrendered with a *server-only* markdown module";

/**
 * RSC fields demo (§16, experimental `rsc: true`): the markdown module is
 * dynamic-imported inside server code only — its output rides state as an
 * opaque field and the client renders `{state.body}` without ever shipping
 * the renderer.
 */
export default live("/doc")({
  mount: async () => {
    const [{ rsc }, { renderMarkdown }] = await Promise.all([
      import("@rpxd/rsc"),
      import("../lib/markdown.tsx"),
    ]);
    return { source: INITIAL, body: rsc(renderMarkdown(INITIAL)) as unknown };
  },
  rpc: {
    async append(state: Draft<DocState>, { text }: { text: string }) {
      const [{ rsc }, { renderMarkdown }] = await Promise.all([
        import("@rpxd/rsc"),
        import("../lib/markdown.tsx"),
      ]);
      state.source = `${state.source}\n${text}`;
      // Patches replace the whole field — React reconciles (§16).
      state.body = rsc(renderMarkdown(state.source)) as unknown;
    },
  },
})(({ state, rpc }: RenderProps<DocState>) => (
  <main>
    <h1>rpxd rsc doc</h1>
    <section data-testid="doc">{state.body as ReactNode}</section>
    <button type="button" onClick={() => void rpc.append?.({ text: "appended *live*" })}>
      Append
    </button>
  </main>
));
