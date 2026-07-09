/**
 * `ssr` environment entry (no react-server condition): deserialize a Flight
 * payload back to VDOM and render HTML — what rpxd SSR would do with an
 * RSC field before hydration.
 */
import { createFromReadableStream } from "@vitejs/plugin-rsc/ssr";
import type { ReactElement } from "react";
// The streaming renderer: resolving client references suspends, which
// renderToString can't do (this is why rpxd SSR must render RSC fields
// through the stream API in the integration).
import { renderToReadableStream } from "react-dom/server.edge";

export async function htmlFromPayload(payload: string): Promise<string> {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(payload));
      controller.close();
    },
  });
  const root = await createFromReadableStream<ReactElement>(stream);
  const htmlStream = await renderToReadableStream(root);
  await htmlStream.allReady;
  const reader = htmlStream.getReader();
  const decoder = new TextDecoder();
  let html = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    html += decoder.decode(value, { stream: true });
  }
  return html;
}
