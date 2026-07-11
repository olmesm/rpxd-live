/**
 * Type tests for the `instances`/`onDiagnostic` config surface (docs review
 * gaps 5-6): locks `RpxdConfig` against `RpxdHandlerOptions` so the two can't
 * silently drift as the handler grows knobs.
 */
import type { RpxdDiagnosticSink, RpxdHandlerOptions } from "@rpxd/server-bun";
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
          | "maxBufferedBytes"
        >
      | undefined
    >();
  });

  it("onDiagnostic matches the handler's diagnostic sink", () => {
    expectTypeOf<RpxdConfig["onDiagnostic"]>().toEqualTypeOf<RpxdDiagnosticSink | undefined>();
  });
});
