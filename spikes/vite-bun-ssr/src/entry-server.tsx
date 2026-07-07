import { renderToString } from "react-dom/server";
import { App } from "./App.tsx";

/** SSR entry loaded through Vite's module runner (ssrLoadModule). */
export function render(now: string): string {
  return renderToString(<App now={now} />);
}
