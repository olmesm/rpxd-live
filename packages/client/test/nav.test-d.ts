/**
 * Typed `nav` (§7, B6): `props.nav.navigate` autocompletes registered
 * routes. The examples/kitchen-sink `.rpxd/routes.gen.ts` augmentation is in the
 * typecheck program, so its route table is the registered set here.
 */
import type { NavProp } from "@rpxd/core";
import { describe, expectTypeOf, it } from "vitest";

declare const nav: NavProp;

describe("nav.navigate route typing (§7)", () => {
  it("accepts registered paths and rejects unknown ones", () => {
    nav.navigate("/chat");
    nav.navigate("/import", { search: { filter: "all" } });
    // @ts-expect-error — not a registered route
    nav.navigate("/bogus");
    // `patch` takes the JSON-value props record (ADR 0002 §3 / finding 3), not
    // the URL string encoding — `{ limit: 20 }` reaches a `z.number()` schema.
    expectTypeOf(nav.patch).parameter(0).toEqualTypeOf<Record<string, unknown>>();
  });
});
