import { hydrateRoot } from "react-dom/client";
import { App } from "./App.tsx";

const root = document.getElementById("root");
if (root) {
  const now = root.querySelector("p")?.textContent?.replace("rendered at ", "") ?? "";
  hydrateRoot(root, <App now={now} />);
}
