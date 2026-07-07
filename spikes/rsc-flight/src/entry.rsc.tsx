/**
 * `rsc` environment entry (react-server condition): serialize a subtree to
 * a Flight payload string — the thing an rpxd handler would store in state
 * via `rsc(<Doc/>)`.
 */
import { renderToReadableStream } from "@vitejs/plugin-rsc/rsc";
import { Doc } from "./doc.tsx";

/** Serialize `<Doc source={source} />` into a Flight payload string. */
export async function serializeDoc(source: string): Promise<string> {
  const stream = renderToReadableStream(<Doc source={source} />);
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let payload = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    payload += decoder.decode(value, { stream: true });
  }
  return payload;
}

if (import.meta.hot) {
  import.meta.hot.accept();
}
