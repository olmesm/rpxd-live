/**
 * TDD contract for RSC fields (§16, experimental): server-rendered component
 * subtrees as opaque state values. Serialization rides ordinary state; the
 * client swaps marked fields for renderable elements at snapshot time.
 */
import { isValidElement } from "react";
import { describe, expect, it } from "vitest";
import { hydrateRscFields, isRscField } from "../src/client.ts";
import { rsc } from "../src/server.ts";

function Doc({ text }: { text: string }) {
  return <article data-doc>{text}</article>;
}

describe("rsc() server serialization (§16)", () => {
  it("renders the subtree to an opaque JSON-safe field", () => {
    const field = rsc(<Doc text="hello" />);
    expect(isRscField(field)).toBe(true);
    expect(field.$rsc).toContain("data-doc");
    expect(field.$rsc).toContain("hello");
    // opaque + serializable: survives the storage/wire JSON round trip (§16)
    expect(JSON.parse(JSON.stringify(field))).toEqual(field);
  });
});

describe("hydrateRscFields (client patch-apply/snapshot hook)", () => {
  it("replaces marked fields (nested ok) with renderable elements", () => {
    const state = {
      title: "t",
      body: rsc(<Doc text="body" />),
      deep: { inner: rsc(<Doc text="inner" />), n: 1 },
      list: [rsc(<Doc text="li" />), "plain"],
    };
    const hydrated = hydrateRscFields(JSON.parse(JSON.stringify(state)));
    expect(isValidElement(hydrated.body)).toBe(true);
    expect(isValidElement(hydrated.deep.inner)).toBe(true);
    expect(isValidElement(hydrated.list[0])).toBe(true);
    expect(hydrated.title).toBe("t");
    expect(hydrated.list[1]).toBe("plain");
  });

  it("preserves identity for untouched branches (structural sharing, §2)", () => {
    const state = {
      body: JSON.parse(JSON.stringify(rsc(<Doc text="x" />))),
      other: { untouched: true, items: [1, 2, 3] },
    };
    const hydrated = hydrateRscFields(state);
    expect(hydrated.other).toBe(state.other); // no rsc below → same reference
  });

  it("returns the same element for the same payload (stable across re-renders)", () => {
    const state = { body: JSON.parse(JSON.stringify(rsc(<Doc text="same" />))) };
    const first = hydrateRscFields(state).body;
    const second = hydrateRscFields(state).body;
    expect(first).toBe(second); // memoized → React reconciles cheaply
  });

  it("replaces the whole field when the payload changes (no diffing, §16)", () => {
    const a = hydrateRscFields({ body: JSON.parse(JSON.stringify(rsc(<Doc text="v1" />))) });
    const b = hydrateRscFields({ body: JSON.parse(JSON.stringify(rsc(<Doc text="v2" />))) });
    expect(a.body).not.toBe(b.body);
  });

  it("passes non-object values through", () => {
    expect(hydrateRscFields(null)).toBe(null);
    expect(hydrateRscFields(5)).toBe(5);
    expect(hydrateRscFields("s")).toBe("s");
  });
});
