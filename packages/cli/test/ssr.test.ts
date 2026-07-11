/**
 * TDD for the SSR-only RSC verifier (§16, #95): `ensureFlightRuntime` builds
 * this from `process.env.RPXD_SESSION_SECRET` and threads it into
 * `configureRscRuntime` as the 2nd arg. `makeRscVerifier` is exported
 * separately so it's unit-testable without the ssr graph (its own
 * `import("@vitejs/plugin-rsc/ssr")` only resolves there).
 */
import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { makeRscVerifier } from "../src/ssr.ts";

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
