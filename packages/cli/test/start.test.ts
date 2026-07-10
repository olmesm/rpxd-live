/**
 * TDD for the `instances`/`onSecurityEvent` config wiring (docs review gaps
 * 5-6): `RpxdConfig` exposes the server-bun instance-registry tuning knobs
 * and the `SecurityEvent` observability hook; `startApp` must forward them to
 * `createRpxdHandler`. `startApp` itself stands up a full production server
 * (see test-bun/build-start.test.ts), so this pins the pure mapping it uses
 * to build those handler options — the seam closest to `startApp` that's
 * testable without a build.
 */
import { describe, expect, it, vi } from "vitest";
import type { RpxdConfig } from "../src/config.ts";
import { instanceHandlerOptions } from "../src/start.ts";

describe("instanceHandlerOptions (RpxdConfig -> RpxdHandlerOptions wiring)", () => {
  it("forwards configured instance tuning knobs", () => {
    const config: RpxdConfig = {
      instances: { warmTtlMs: 5000, maxUnattachedInstances: 10 },
    };
    expect(instanceHandlerOptions(config)).toEqual({
      warmTtlMs: 5000,
      maxUnattachedInstances: 10,
      onSecurityEvent: undefined,
    });
  });

  it("forwards onSecurityEvent", () => {
    const onSecurityEvent = vi.fn();
    const config: RpxdConfig = { onSecurityEvent };
    expect(instanceHandlerOptions(config).onSecurityEvent).toBe(onSecurityEvent);
  });

  it("regression: omitted instances/onSecurityEvent adds no overrides (handler defaults apply)", () => {
    expect(instanceHandlerOptions({})).toEqual({ onSecurityEvent: undefined });
  });
});
