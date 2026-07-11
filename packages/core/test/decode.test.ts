import { describe, expect, it } from "vitest";
import { decodeBatch } from "../src/decode.ts";
import { PROTOCOL_VERSION } from "../src/protocol.ts";

describe("decodeBatch", () => {
  it("accepts a well-formed batch", () => {
    const raw = {
      v: PROTOCOL_VERSION,
      instance: "inst-1",
      rpcId: "rpc-1",
      calls: [{ rpc: "add", payload: { text: "hi" } }],
    };
    const result = decodeBatch(raw);
    expect(result.ok).toBe(true);
    expect(result.ok && result.batch).toEqual(raw);
  });

  it("accepts a batch with an empty calls array", () => {
    const raw = { v: PROTOCOL_VERSION, instance: "inst-1", rpcId: "rpc-1", calls: [] };
    const result = decodeBatch(raw);
    expect(result).toEqual({ ok: true, batch: raw });
  });

  for (const raw of [null, undefined, 42, "batch", true]) {
    it(`rejects non-object input: ${JSON.stringify(raw)}`, () => {
      expect(decodeBatch(raw)).toEqual({ ok: false, reason: "not-an-object" });
    });
  }

  it("treats an array as a non-null object — falls through to the instance check", () => {
    // typeof [] === "object" and it isn't null, so the not-an-object gate
    // doesn't reject it; it fails the next gate instead (no `instance` field).
    expect(decodeBatch([])).toEqual({ ok: false, reason: "instance-not-string" });
  });

  it("rejects when instance is not a string", () => {
    expect(decodeBatch({ instance: 42, rpcId: "r1", calls: [] })).toEqual({
      ok: false,
      reason: "instance-not-string",
    });
  });

  it("rejects when instance is missing entirely", () => {
    expect(decodeBatch({ rpcId: "r1", calls: [] })).toEqual({
      ok: false,
      reason: "instance-not-string",
    });
  });

  it("rejects when rpcId is not a string, carrying instance", () => {
    expect(decodeBatch({ instance: "inst-1", rpcId: 42, calls: [] })).toEqual({
      ok: false,
      reason: "rpcId-not-string",
      instance: "inst-1",
    });
  });

  it("rejects when calls is null, carrying rpcId and instance", () => {
    expect(decodeBatch({ instance: "inst-1", rpcId: "r1", calls: null })).toEqual({
      ok: false,
      reason: "calls-not-array",
      rpcId: "r1",
      instance: "inst-1",
    });
  });

  it("rejects when calls is undefined", () => {
    expect(decodeBatch({ instance: "inst-1", rpcId: "r1", calls: undefined })).toEqual({
      ok: false,
      reason: "calls-not-array",
      rpcId: "r1",
      instance: "inst-1",
    });
  });

  it("rejects when calls is a number", () => {
    expect(decodeBatch({ instance: "inst-1", rpcId: "r1", calls: 42 })).toEqual({
      ok: false,
      reason: "calls-not-array",
      rpcId: "r1",
      instance: "inst-1",
    });
  });

  it("rejects when calls is a plain object", () => {
    expect(decodeBatch({ instance: "inst-1", rpcId: "r1", calls: {} })).toEqual({
      ok: false,
      reason: "calls-not-array",
      rpcId: "r1",
      instance: "inst-1",
    });
  });

  it("rejects a malformed call element (missing rpc)", () => {
    expect(
      decodeBatch({
        instance: "inst-1",
        rpcId: "r1",
        calls: [{ payload: {} }],
      }),
    ).toEqual({ ok: false, reason: "calls-malformed", rpcId: "r1", instance: "inst-1" });
  });

  it("rejects a malformed call element (rpc not a string)", () => {
    expect(
      decodeBatch({
        instance: "inst-1",
        rpcId: "r1",
        calls: [{ rpc: 42, payload: {} }],
      }),
    ).toEqual({ ok: false, reason: "calls-malformed", rpcId: "r1", instance: "inst-1" });
  });

  it("rejects a malformed call element (payload missing)", () => {
    expect(
      decodeBatch({
        instance: "inst-1",
        rpcId: "r1",
        calls: [{ rpc: "add" }],
      }),
    ).toEqual({ ok: false, reason: "calls-malformed", rpcId: "r1", instance: "inst-1" });
  });

  it("accepts payload: undefined as present (explicit key)", () => {
    // "present" per the spec means the key exists — an explicit `undefined`
    // value still counts, only a missing key does not.
    const raw = {
      instance: "inst-1",
      rpcId: "r1",
      calls: [{ rpc: "add", payload: undefined }],
    };
    expect(decodeBatch(raw)).toEqual({ ok: true, batch: raw });
  });

  it("rejects a malformed call element that isn't an object", () => {
    expect(
      decodeBatch({
        instance: "inst-1",
        rpcId: "r1",
        calls: [null],
      }),
    ).toEqual({ ok: false, reason: "calls-malformed", rpcId: "r1", instance: "inst-1" });
  });

  it("rejects when one of several call elements is malformed", () => {
    expect(
      decodeBatch({
        instance: "inst-1",
        rpcId: "r1",
        calls: [{ rpc: "add", payload: {} }, { rpc: "bad" }],
      }),
    ).toEqual({ ok: false, reason: "calls-malformed", rpcId: "r1", instance: "inst-1" });
  });

  it("never throws for any input", () => {
    const inputs: unknown[] = [
      null,
      undefined,
      0,
      "",
      NaN,
      Symbol("x"),
      () => {},
      new Date(),
      { instance: "i", rpcId: "r", calls: [1, 2, 3] },
      { instance: "i", rpcId: "r", calls: [{ rpc: "x", payload: 1 }, "nope"] },
    ];
    for (const input of inputs) {
      expect(() => decodeBatch(input)).not.toThrow();
    }
  });
});
