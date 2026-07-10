// @ts-check
import starlight from "@astrojs/starlight";
import { defineConfig } from "astro/config";
import ecTwoSlash from "expressive-code-twoslash";
import starlightTypeDoc, { typeDocSidebarGroup } from "starlight-typedoc";

// Public, user-facing packages — each exports its API from a single entry.
// TypeDoc reads the TSDoc (with CI-enforced @example blocks) straight off these
// sources and starlight-typedoc renders them into the `api/` section.
const apiEntryPoints = [
  "../packages/core/src/index.ts",
  "../packages/client/src/index.ts",
  "../packages/client/src/react.ts",
  "../packages/server-bun/src/index.ts",
  "../packages/vite-plugin/src/index.ts",
  "../packages/cli/src/index.ts",
  "../packages/testing/src/index.ts",
  "../packages/storage-memory/src/index.ts",
  "../packages/storage-session/src/index.ts",
  "../packages/storage-sqlite/src/index.ts",
  "../packages/storage-redis/src/index.ts",
  "../packages/adapter-node/src/index.ts",
  "../packages/rsc/src/server.ts",
  "../packages/rsc/src/client.ts",
];

// Project-site deploy: served from a subpath on the user's github.io host.
// `site` + `base` keep every generated link correct under /rpxd-live/.
export default defineConfig({
  site: "https://olmesm.github.io",
  base: "/rpxd-live",
  integrations: [
    starlight({
      // Twoslash (opt-in per block via the `twoslash` meta flag): hover-for-types
      // and inline type errors, so readers can see the inferred fluent-chain
      // contract directly in the docs.
      expressiveCode: {
        plugins: [ecTwoSlash()],
      },
      title: "rpxd",
      description:
        "A live-object framework for React: server-side stateful objects with reducers, Immer patches over SSE/WS, optimistic replay on the client.",
      social: [
        {
          icon: "github",
          label: "GitHub",
          href: "https://github.com/olmesm/rpxd-live",
        },
      ],
      plugins: [
        starlightTypeDoc({
          entryPoints: apiEntryPoints,
          tsconfig: "./tsconfig.typedoc.json",
          output: "api",
          sidebar: { label: "API reference", collapsed: true },
          typeDoc: {
            // Group all packages under one section; each package's entry
            // becomes a module named from its package.json `name`.
            readme: "none",
            excludeInternal: true,
            excludeExternals: true,
            gitRevision: "main",
          },
        }),
      ],
      sidebar: [
        {
          label: "Getting started",
          items: [
            { label: "Introduction", slug: "getting-started/introduction" },
            { label: "How rpxd compares", slug: "getting-started/comparison" },
            { label: "Installation", slug: "getting-started/installation" },
            { label: "Your first live object", slug: "getting-started/first-live-object" },
          ],
        },
        {
          label: "Guides",
          items: [{ autogenerate: { directory: "guides" } }],
        },
        {
          label: "Operations",
          items: [{ autogenerate: { directory: "operations" } }],
        },
        {
          label: "Concepts",
          items: [{ autogenerate: { directory: "concepts" } }],
        },
        {
          label: "Examples",
          items: [{ autogenerate: { directory: "examples" } }],
        },
        typeDocSidebarGroup,
      ],
    }),
  ],
});
