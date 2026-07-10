/**
 * Type tests for the `instances`/`onSecurityEvent` config surface (docs
 * review gaps 5-6): locks `RpxdConfig` against `RpxdHandlerOptions` so the
 * two can't silently drift as the handler grows knobs.
 */
import type { RpxdHandlerOptions, SecurityEvent } from "@rpxd/server-bun";
import { describe, expectTypeOf, it } from "vitest";
import type { RpxdConfig } from "../src/config.ts";

describe("RpxdConfig instance/observability knobs", () => {
  it("instances mirrors the RpxdHandlerOptions tuning knobs", () => {
    expectTypeOf<RpxdConfig["instances"]>().toEqualTypeOf<
      | Pick<
          RpxdHandlerOptions,
          | "warmTtlMs"
          | "attachTtlMs"
          | "unattachedTtlMs"
          | "maxUnattachedInstances"
          | "maxInstancesPerSession"
        >
      | undefined
    >();
  });

  it("onSecurityEvent matches the handler's SecurityEvent hook", () => {
    expectTypeOf<RpxdConfig["onSecurityEvent"]>().toEqualTypeOf<
      ((event: SecurityEvent) => void) | undefined
    >();
  });
});
