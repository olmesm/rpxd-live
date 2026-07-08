import { describe, expect, it } from "vitest";
import { applyConfigOverrides, type RpxdConfig } from "../src/config.ts";

describe("applyConfigOverrides (CLI --transport / --rsc)", () => {
  it("overrides transport and rsc", () => {
    const config: RpxdConfig = { rsc: true, transport: { kind: "sse" } };
    applyConfigOverrides(config, { transport: "ws", rsc: false });
    expect(config.transport).toEqual({ kind: "ws" });
    expect(config.rsc).toBe(false);
  });

  it("leaves fields untouched when no override is given", () => {
    const config: RpxdConfig = { rsc: true, transport: { kind: "sse" } };
    applyConfigOverrides(config, {});
    expect(config.transport).toEqual({ kind: "sse" });
    expect(config.rsc).toBe(true);
  });

  it("applies --rsc / --no-rsc independently of transport", () => {
    const off: RpxdConfig = { rsc: true };
    applyConfigOverrides(off, { rsc: false });
    expect(off.rsc).toBe(false);

    const on: RpxdConfig = { rsc: false };
    applyConfigOverrides(on, { rsc: true });
    expect(on.rsc).toBe(true);
  });

  it("is a no-op when overrides is undefined", () => {
    const config: RpxdConfig = { rsc: true };
    expect(applyConfigOverrides(config, undefined)).toBe(config);
    expect(config.rsc).toBe(true);
  });
});
