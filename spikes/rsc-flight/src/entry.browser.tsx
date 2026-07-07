/**
 * `client` environment entry: deserialize the Flight payload in the browser
 * and mount — the client half of §16 step 2. Exercised indirectly in this
 * spike (the dev test asserts the module reference resolves); full browser
 * hydration is the integration step's e2e.
 */
import { createFromReadableStream } from "@vitejs/plugin-rsc/browser";
import type { ReactElement } from "react";
import { createRoot } from "react-dom/client";

export async function mountPayload(payload: string, el: HTMLElement): Promise<void> {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(payload));
      controller.close();
    },
  });
  const root = await createFromReadableStream<ReactElement>(stream);
  createRoot(el).render(root);
}
