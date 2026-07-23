import { describe, expect, it } from "vitest";
import { canonicalProps, decodeProps, encodeProps } from "../src/props-codec.ts";

/**
 * A representative set of JSON-object props records — the codec must survive a
 * full `decodeProps(encodeProps(x))` round trip on every one, deep-equal to the
 * original. Covers nested objects, arrays, numbers, booleans, null, plain
 * strings, and the ambiguous strings (`"20"`, `"true"`, JSON-shaped strings)
 * whose bare URL form would otherwise decode back as a non-string.
 */
const ROUND_TRIP_CASES: Record<string, unknown>[] = [
  {},
  { filter: "done" },
  { q: "hello world", tag: "a/b c" },
  { limit: 20, page: 0, ratio: 1.5, neg: -3 },
  { done: true, hidden: false },
  { cursor: null },
  { ids: [1, 2, 3], names: ["a", "b"] },
  { where: { orgId: "acme", nested: { deep: [true, null, "x"] } } },
  // Ambiguous strings: bare in the URL they would parse to a non-string, so
  // encodeProps must quote them.
  { v: "20" },
  { flag: "true", n: "null", f: "false" },
  { jsonish: '{"a":1}', arrish: "[1,2]" },
  { mixed: "done", count: 5, active: true, meta: { note: "42" } },
  // Numeric-looking strings that are NOT valid JSON numbers stay bare and still
  // round-trip as strings.
  { zip: "007", ver: "1.2.3" },
  { empty: "" },
];

describe("props codec round trip", () => {
  for (const [i, input] of ROUND_TRIP_CASES.entries()) {
    it(`decodeProps(encodeProps(x)) deep-equals x — case ${i}`, () => {
      expect(decodeProps(encodeProps(input))).toEqual(input);
    });
  }
});

describe("encodeProps ambiguity", () => {
  it('quotes an ambiguous string ("20") so it decodes back as a string', () => {
    const qs = encodeProps({ v: "20" });
    // The wire value is JSON-encoded (quoted), never the bare `20`.
    expect(qs.get("v")).toBe('"20"');
    expect(decodeProps(qs)).toEqual({ v: "20" });
  });

  it("leaves a plain non-ambiguous string bare for URL readability", () => {
    const qs = encodeProps({ filter: "done" });
    expect(qs.get("filter")).toBe("done");
  });

  it("JSON-encodes non-string values", () => {
    const qs = encodeProps({ limit: 20, active: true, cursor: null });
    expect(qs.get("limit")).toBe("20");
    expect(qs.get("active")).toBe("true");
    expect(qs.get("cursor")).toBe("null");
  });
});

describe("decodeProps parse-else-string", () => {
  it("decodes `?limit=20` to the number 20", () => {
    expect(decodeProps(new URLSearchParams("limit=20"))).toEqual({ limit: 20 });
  });

  it('decodes `?filter=done` to the string "done"', () => {
    expect(decodeProps(new URLSearchParams("filter=done"))).toEqual({ filter: "done" });
  });

  it("decodes JSON objects, arrays, booleans, and null", () => {
    expect(decodeProps(new URLSearchParams("where=%7B%22a%22%3A1%7D"))).toEqual({
      where: { a: 1 },
    });
    expect(decodeProps(new URLSearchParams("ok=true&cursor=null"))).toEqual({
      ok: true,
      cursor: null,
    });
  });
});

describe("canonicalProps deep-equality serialization (ADR 0002 item 8)", () => {
  it("is order-independent (top-level and nested keys)", () => {
    expect(canonicalProps({ a: 1, b: 2 })).toBe(canonicalProps({ b: 2, a: 1 }));
    expect(canonicalProps({ x: { p: 1, q: 2 } })).toBe(canonicalProps({ x: { q: 2, p: 1 } }));
  });

  it("distinguishes different values and different string/number types", () => {
    expect(canonicalProps({ tab: "a" })).not.toBe(canonicalProps({ tab: "b" }));
    expect(canonicalProps({ v: 20 })).not.toBe(canonicalProps({ v: "20" }));
  });

  it("preserves array order (arrays are significant, not sorted)", () => {
    expect(canonicalProps({ xs: [1, 2] })).not.toBe(canonicalProps({ xs: [2, 1] }));
    expect(canonicalProps({ xs: [1, 2] })).toBe(canonicalProps({ xs: [1, 2] }));
  });

  it("omits undefined-valued keys (JSON parity), so `{a:1}` ≡ `{a:1, b:undefined}`", () => {
    expect(canonicalProps({ a: 1, b: undefined })).toBe(canonicalProps({ a: 1 }));
  });
});
