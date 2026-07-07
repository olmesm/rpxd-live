import { defineConfig } from "@rpxd/cli";

export default defineConfig({
  // memory() storage and sse() transport are the defaults (§14)
  rsc: true, // §16 experimental flag — flipped after ①–⑤ went green
});
