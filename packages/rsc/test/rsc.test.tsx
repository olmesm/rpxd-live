/**
 * Contract for RSC fields (§16): Flight-serialized subtrees as opaque
 * state values. Flight serialization/deserialization itself needs the plugin
 * environments and is covered by `test-bun/flight.test.ts` and the doc e2e;
 * these tests pin the marker shape, the traversal, and the caching semantics.
 */
import { isValidElement } from "react";
import { describe, expect, it } from "vitest";
import { hydrateRscFields, isRscField } from "../src/client.ts";
// The package's "." export is conditional (react-server → real impl);
// every other graph — including this test — resolves the stub.
import { rsc } from "../src/server-stub.ts";
import { decodeStream } from "../src/shared.ts";

const field = (payload: string) => ({ $rsc: payload });

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
