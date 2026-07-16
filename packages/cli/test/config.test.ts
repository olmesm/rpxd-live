import { afterEach, describe, expect, it } from "vitest";
import {
  applyConfigOverrides,
  configSlotRegistrations,
  propagateSessionSecretEnv,
  type RpxdConfig,
  type SlotModule,
} from "../src/config.ts";

describe("configSlotRegistrations (ADR 0002 item 6 — slots escape hatch)", () => {
  const slot = (path: string): SlotModule => ({
    $live: true,
    path,
    def: { setup: () => ({}) } as SlotModule["def"],
    props: undefined,
  });

  it("maps config slot live objects to mount registrations (path/def/props)", () => {
    const chat = slot("/chat");
    const regs = configSlotRegistrations({ slots: [chat] });
    expect(regs).toEqual([{ path: "/chat", def: chat.def, props: undefined }]);
  });

  it("returns [] when no slots are configured", () => {
    expect(configSlotRegistrations({})).toEqual([]);
    expect(configSlotRegistrations({ slots: [] })).toEqual([]);
  });
});

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

/**
 * Secret propagation into `RPXD_SESSION_SECRET` (§16, #95): `rsc()` (react-
 * server graph) and the SSR verifier (`packages/cli/src/ssr.ts`) run in
 * separate module graphs sharing one process — this env var is the only
 * channel between them. Vitest runs as development (see `vitest.config.ts`),
 * so `isDev()` is true here unless a test overrides `NODE_ENV` itself.
 */
describe("propagateSessionSecretEnv (§16, #95 — CLI → RPXD_SESSION_SECRET)", () => {
  const ENV_KEY = "RPXD_SESSION_SECRET";
  afterEach(() => {
    delete process.env[ENV_KEY];
  });

  it("propagates config.session.secret verbatim", () => {
    propagateSessionSecretEnv({ session: { secret: "configured-secret" } });
    expect(process.env[ENV_KEY]).toBe("configured-secret");
  });

  it("mints an ephemeral secret in development when none is configured", () => {
    delete process.env[ENV_KEY];
    propagateSessionSecretEnv({});
    expect(process.env[ENV_KEY]).toMatch(/^[0-9a-f]{64}$/);
  });

  it("never clobbers an existing env var", () => {
    process.env[ENV_KEY] = "already-set";
    propagateSessionSecretEnv({ session: { secret: "different-secret" } });
    expect(process.env[ENV_KEY]).toBe("already-set");
  });

  it("does not set an empty string (prod, no secret configured)", () => {
    const prevNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      delete process.env[ENV_KEY];
      propagateSessionSecretEnv({});
      expect(process.env[ENV_KEY]).toBeUndefined();
    } finally {
      process.env.NODE_ENV = prevNodeEnv;
    }
  });

  it("is a no-op under the explicit cookie.sign:false escape hatch — rsc() runs unsigned too", () => {
    delete process.env[ENV_KEY];
    propagateSessionSecretEnv({
      session: { secret: "configured-secret", cookie: { sign: false } },
    });
    expect(process.env[ENV_KEY]).toBeUndefined();
  });
});
