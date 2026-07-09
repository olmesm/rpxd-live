/**
 * RSC Flight conformance fixture (§16): `@vitejs/plugin-rsc` driving rpxd's
 * RSC-fields model under Vite-on-Bun.
 *
 * Shape under test: we keep our own server (serverHandler: false) and use
 * the plugin's environments the way rpxd would — the `rsc` environment
 * serializes a subtree (with a 'use client' island) into a Flight payload
 * that rides state; the `ssr` environment deserializes it for HTML.
 */
import rsc from "@vitejs/plugin-rsc";
import { defineConfig } from "vite";

export default defineConfig({
  logLevel: "error",
  plugins: [
    rsc({
      entries: {
        rsc: "./src/entry.rsc.tsx",
        ssr: "./src/entry.ssr.tsx",
        client: "./src/entry.browser.tsx",
      },
      // rpxd owns the request loop; the plugin only provides environments.
      serverHandler: false,
    }),
  ],
});
