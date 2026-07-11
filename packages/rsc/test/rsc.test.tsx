/**
 * Contract for RSC fields (§16): Flight-serialized subtrees as opaque
 * state values. Flight serialization/deserialization itself needs the plugin
 * environments and is covered by `test-bun/flight.test.ts` and the doc e2e;
 * these tests pin the marker shape, the traversal, and the caching semantics.
 */
import { createHmac } from "node:crypto";
import { createElement, isValidElement } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { configureRscRuntime, hydrateRscFields, isRscField } from "../src/client.ts";
// signRscField is the pure HMAC-signing half of rsc() (#95), extracted so it's
// unit-testable without the react-server graph — rsc() itself (which this
// file cannot exercise, see above) just calls it after Flight-serializing.
import { signRscField } from "../src/server.ts";
// The package's "." export is conditional (react-server → real impl);
// every other graph — including this test — resolves the stub.
import { rsc } from "../src/server-stub.ts";
import { decodeStream } from "../src/shared.ts";

const field = (payload: string) => ({ $rsc: payload });
const tagged = (payload: string, $rscTag: string) => ({ $rsc: payload, $rscTag });

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

/** A ReadableStreamDefaultReader over a fixed list of byte chunks. */
function chunkReader(chunks: Uint8Array[]): ReadableStreamDefaultReader<Uint8Array> {
  let i = 0;
  return {
    read: async () =>
      i < chunks.length
        ? { value: chunks[i++] as Uint8Array, done: false }
        : { value: undefined, done: true },
  } as ReadableStreamDefaultReader<Uint8Array>;
}

describe("decodeStream (Flight byte assembly, §16)", () => {
  it("reassembles a multi-byte char split across chunk boundaries", async () => {
    // "😀" = f0 9f 98 80, split across two chunks.
    const out = await decodeStream(
      chunkReader([new Uint8Array([0xf0, 0x9f]), new Uint8Array([0x98, 0x80])]),
    );
    expect(out).toBe("😀");
  });

  it("does not silently drop bytes buffered at stream end (final flush)", async () => {
    // Stream ends mid-character (3 of the 4 bytes). Without the final
    // decoder.decode() flush the buffered bytes vanish → silent truncation.
    const out = await decodeStream(chunkReader([new Uint8Array([0xf0, 0x9f, 0x98])]));
    expect(out).not.toBe("");
  });
});

describe("rsc() server serialization (§16)", () => {
  it("throws a pointer at rsc: true outside the react-server graph", async () => {
    await expect(rsc(<article>hi</article>)).rejects.toThrow(/rsc: true/);
  });
});

describe("signRscField — SSR-only HMAC brand (§16, #95)", () => {
  it("stamps $rscTag = HMAC-SHA256(payload, RPXD_SESSION_SECRET) (hex) when a secret is configured", () => {
    withEnvSecret("test-secret", () => {
      const out = signRscField("<p>hi</p>");
      expect(out.$rsc).toBe("<p>hi</p>");
      expect(out.$rscTag).toBe(
        createHmac("sha256", "test-secret").update("<p>hi</p>").digest("hex"),
      );
    });
  });

  it("ships unsigned (no $rscTag) when no secret is configured — best-effort, never throws", () => {
    withEnvSecret(undefined, () => {
      const out = signRscField("<p>hi</p>");
      expect(out.$rsc).toBe("<p>hi</p>");
      expect(out.$rscTag).toBeUndefined();
    });
  });

  it("a genuine tag verifies; a forged tag / tampered payload does not (mirrors the SSR verifier)", () => {
    withEnvSecret("shared-secret", () => {
      const genuine = signRscField("payload-A");
      const want = createHmac("sha256", "shared-secret").update("payload-A").digest("hex");
      expect(genuine.$rscTag).toBe(want);

      // Forged tag over the same payload.
      const forgedTag = createHmac("sha256", "wrong-secret").update("payload-A").digest("hex");
      expect(forgedTag).not.toBe(want);

      // Tampered payload under the genuine tag.
      const wantForOther = createHmac("sha256", "shared-secret").update("payload-B").digest("hex");
      expect(wantForOther).not.toBe(want);
    });
  });
});

describe("hydrateRscFields (client patch-apply/snapshot hook)", () => {
  it("replaces marked fields (nested ok) with renderable elements", () => {
    const state = {
      title: "t",
      body: field("B"),
      deep: { inner: field("I"), n: 1 },
      list: [field("L"), "plain"],
    };
    const hydrated = hydrateRscFields(state);
    expect(isValidElement(hydrated.body)).toBe(true);
    expect(isValidElement(hydrated.deep.inner)).toBe(true);
    expect(isValidElement(hydrated.list[0])).toBe(true);
    expect(hydrated.title).toBe("t");
    expect(hydrated.list[1]).toBe("plain");
  });

  it("preserves identity for untouched branches (structural sharing, §2)", () => {
    const state = {
      body: field("x"),
      other: { untouched: true, items: [1, 2, 3] },
    };
    const hydrated = hydrateRscFields(state);
    expect(hydrated.other).toBe(state.other); // no rsc below → same reference
  });

  it("memoizes elements per payload — same field, same element", () => {
    const a = hydrateRscFields({ body: field("same") });
    const b = hydrateRscFields({ body: field("same") });
    expect(a.body).toBe(b.body); // React reconciles by identity (§2)
    const c = hydrateRscFields({ body: field("different") });
    expect(c.body).not.toBe(a.body);
  });

  it("leaves non-marker values alone", () => {
    expect(isRscField({ $rsc: "p" })).toBe(true);
    expect(isRscField({ rsc: "p" })).toBe(false);
    expect(hydrateRscFields("plain")).toBe("plain");
    expect(hydrateRscFields(42)).toBe(42);
    expect(hydrateRscFields(null)).toBe(null);
  });
});

/**
 * SSR-only verification gate (#95): configureRscRuntime's optional 2nd arg.
 * These tests use distinct payload strings per case — verification (like
 * deserialization) is memoized per unique payload (§16), so reusing a
 * payload string across a pass/fail pair would read a stale cached verdict.
 */
describe("configureRscRuntime verify — SSR-only HMAC gate (§16, #95)", () => {
  const deserializesTo = (marker: string) => async () =>
    createElement("span", { "data-marker": marker }, marker);

  afterEach(() => {
    // Reset to the browser shape (no verifier) so this block can't leak a
    // configured verifier into any test that runs after it in this file.
    configureRscRuntime(deserializesTo("reset"));
  });

  it("deserializes a genuine field when the configured verifier accepts it", () => {
    configureRscRuntime(deserializesTo("ok"), (f) => f.$rscTag === "valid");
    const hydrated = hydrateRscFields({ body: tagged("verify-genuine-payload", "valid") });
    expect(isValidElement(hydrated.body)).toBe(true);
  });

  it("does NOT deserialize a forged-tag field — hydrateRscFields leaves it untouched", () => {
    configureRscRuntime(deserializesTo("ok"), (f) => f.$rscTag === "valid");
    const state = { body: tagged("verify-forged-payload", "forged") };
    const hydrated = hydrateRscFields(state);
    // Same reference as the original marker object — never routed to elementFor.
    expect(hydrated.body).toBe(state.body);
  });

  it("does NOT deserialize a field with no tag once a secret/verifier exists", () => {
    configureRscRuntime(deserializesTo("ok"), (f) => f.$rscTag === "valid");
    const state = { body: field("verify-missing-tag-payload") };
    const hydrated = hydrateRscFields(state);
    expect(hydrated.body).toBe(state.body);
  });

  it("with NO verifier configured (browser), a field deserializes regardless of its tag", () => {
    configureRscRuntime(deserializesTo("ok")); // no verify arg — the browser shape
    const hydrated = hydrateRscFields({ body: tagged("verify-no-verifier-payload", "anything") });
    expect(isValidElement(hydrated.body)).toBe(true);
  });
});
