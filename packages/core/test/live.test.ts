/**
 * Runtime tests for the fluent `live()` builder — the fold (ADR 0002 item 2).
 *
 * These pin the runtime side of the props-schema arg: the schema lands on the
 * built route object, schema-less chains build unchanged, and the leading-slash
 * assert throws for programming errors.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { live } from "../src/live.ts";

describe("live() — the fold (ADR 0002 item 2)", () => {
  it("carries the props schema on the built route object", () => {
    const schema = z.object({ variant: z.enum(["compact", "full"]) });
    const route = live("/card/$productId", schema)
      .setup(() => ({ chosen: "" }))
      .render(() => null);
    expect(route.props).toBe(schema);
  });

  it("leaves props undefined for schema-less routes", () => {
    const route = live("/org/$orgId")
      .setup(() => ({ n: 0 }))
      .render(() => null);
    expect(route.props).toBeUndefined();
  });

  it('throws when the pattern does not start with "/"', () => {
    expect(() => live("card/$id")).toThrow('live(): pattern must start with "/" — got "card/$id"');
  });

  it("throws for a bare word pattern too (the assert fires in every environment)", () => {
    expect(() => live("")).toThrow('live(): pattern must start with "/" — got ""');
  });

  it("builds a schema-less chain identically to before (regression)", () => {
    const route = live("/")
      .setup(() => ({ n: 0 }))
      .version("v2")
      .rpc("bump", (r) => r.handler(async (_p, ctx) => ctx.patchState((s) => void s.n++)))
      .on("ping", (state) => void state)
      .guard(async () => {})
      .load(async () => {})
      .render(() => null);
    expect(route.$live).toBe(true);
    expect(route.path).toBe("/");
    expect(route.def.version).toBe("v2");
    const bump = route.def.rpc?.bump;
    expect(bump && typeof bump === "object" && typeof bump.handler).toBe("function");
    expect(typeof route.def.on?.ping).toBe("function");
    expect(typeof route.def.guard).toBe("function");
    expect(typeof route.def.load).toBe("function");
    expect(route.props).toBeUndefined();
  });
});
