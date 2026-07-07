/**
 * Contract for RSC fields (§16 step 2): Flight-serialized subtrees as opaque
 * state values. Flight serialization/deserialization itself needs the plugin
 * environments and is covered by `spikes/rsc-flight` and the doc e2e; these
 * tests pin the marker shape, the traversal, and the caching semantics.
 */
import { isValidElement } from "react";
import { describe, expect, it } from "vitest";
import { hydrateRscFields, isRscField } from "../src/client.ts";
// The package's "." export is conditional (react-server → real impl);
// every other graph — including this test — resolves the stub.
import { rsc } from "../src/server-stub.ts";

const field = (payload: string) => ({ $rsc: payload });

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
