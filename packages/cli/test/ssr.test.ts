/**
 * TDD for the SSR-only RSC verifier (§16, #95): `ensureFlightRuntime` builds
 * this from `process.env.RPXD_SESSION_SECRET` and threads it into
 * `configureRscRuntime` as the 2nd arg. `makeRscVerifier` is exported
 * separately so it's unit-testable without the ssr graph (its own
 * `import("@vitejs/plugin-rsc/ssr")` only resolves there).
 */
import { createHmac } from "node:crypto";
import type { LiveRoute } from "@rpxd/core";
import type { RenderContext } from "@rpxd/server-bun";
import { createElement, type FunctionComponent, type ReactNode } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { makeRscVerifier, renderRoute, type ShellComponents } from "../src/ssr.ts";

const ENV_KEY = "RPXD_SESSION_SECRET";

function withEnvSecret<T>(value: string | undefined, run: () => T): T {
  const prev = process.env[ENV_KEY];
  if (value === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = value;
  try {
    return run();
  } finally {
    if (prev === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = prev;
  }
}

const ctx = {
  instance: "inst/1",
  seq: 1,
  attachToken: "tok",
  state: {},
  session: {},
  path: "/",
  params: {},
} as unknown as RenderContext;

const assets = { entrySrc: "/entry.js" };

const pageRoute = {
  component: (() => createElement("main", null, "PAGE")) as FunctionComponent<object>,
} as unknown as LiveRoute<unknown, string, unknown, FunctionComponent<object>>;

describe("renderRoute — the persistent region composition (ADR 0002 item 13)", () => {
  it("composes Root(Layout(page)) so the SSR markup matches the client's hydrated tree", async () => {
    const shell: ShellComponents = {
      Root: ({ children }: { children?: ReactNode }) =>
        createElement("div", { id: "root-shell" }, children),
      Layout: ({ children }: { children?: ReactNode }) =>
        createElement("aside", { id: "layout-shell" }, children),
    };
    const html = await renderRoute(pageRoute, ctx, assets, { shell });
    // Root wraps the layout, which wraps the page — nesting order intact.
    expect(html).toContain('<div id="root-shell">');
    expect(html).toContain('<aside id="layout-shell">');
    expect(html).toMatch(/id="layout-shell"[^>]*><main>PAGE<\/main>/);
    // Bootstrap + hydration entry still present (a live page, unchanged §12 shell).
    expect(html).toContain('id="__rpxd"');
    expect(html).toContain('src="/entry.js"');
  });

  it("renders the page directly when there is no __layout (layout-less parity)", async () => {
    const shell: ShellComponents = {
      Root: ({ children }: { children?: ReactNode }) =>
        createElement("div", { id: "root-shell" }, children),
    };
    const html = await renderRoute(pageRoute, ctx, assets, { shell });
    expect(html).toContain('<div id="root-shell"><main>PAGE</main></div>');
    expect(html).not.toContain("layout-shell");
  });
});

describe("makeRscVerifier (§16, #95 — SSR-only HMAC verification)", () => {
  afterEach(() => {
    delete process.env[ENV_KEY];
  });

  it("returns undefined (deserialize unverified, back-compat) when no secret is configured", () => {
    withEnvSecret(undefined, () => {
      expect(makeRscVerifier()).toBeUndefined();
    });
  });

  it("accepts a genuine field signed with the matching secret (mirrors server.ts's HMAC)", () => {
    withEnvSecret("shared-secret", () => {
      const payload = "<p>hi</p>";
      const tag = createHmac("sha256", "shared-secret").update(payload).digest("hex");
      const verify = makeRscVerifier();
      expect(verify?.({ $rsc: payload, $rscTag: tag })).toBe(true);
    });
  });

  it("rejects a forged tag", () => {
    withEnvSecret("shared-secret", () => {
      const verify = makeRscVerifier();
      expect(verify?.({ $rsc: "<p>hi</p>", $rscTag: "deadbeef".repeat(8) })).toBe(false);
    });
  });

  it("rejects a tampered payload (tag was computed for a different payload)", () => {
    withEnvSecret("shared-secret", () => {
      const tag = createHmac("sha256", "shared-secret").update("original").digest("hex");
      const verify = makeRscVerifier();
      expect(verify?.({ $rsc: "tampered", $rscTag: tag })).toBe(false);
    });
  });

  it("rejects an absent tag once a secret is configured", () => {
    withEnvSecret("shared-secret", () => {
      const verify = makeRscVerifier();
      expect(verify?.({ $rsc: "<p>hi</p>" })).toBe(false);
    });
  });

  it("rejects a tag signed with a different secret", () => {
    withEnvSecret("shared-secret", () => {
      const tag = createHmac("sha256", "other-secret").update("<p>hi</p>").digest("hex");
      const verify = makeRscVerifier();
      expect(verify?.({ $rsc: "<p>hi</p>", $rscTag: tag })).toBe(false);
    });
  });
});
