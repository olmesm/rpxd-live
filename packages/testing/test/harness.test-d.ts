/**
 * Type tests for the testing harness: `t.rpc.*` carries the route's exact
 * rpc record — same keys, same payloads as the component's facade (§5).
 */
import { live } from "@rpxd/core";
import { describe, expectTypeOf, it } from "vitest";
import { z } from "zod";
import { testLive } from "../src/index.ts";

const route = live("/org/$orgId")
  .mount(async ({ orgId }) => ({ orgId, todos: [] as { id: string; text: string }[] }))
  .rpc("add", (r) =>
    r.input(z.object({ text: z.string() })).handler(async ({ text }, ctx) => {
      ctx.patchState((s) => {
        s.todos.push({ id: "x", text });
      });
    }),
  )
  .rpc("clear", (r) =>
    r.handler(async (_p, ctx) => {
      ctx.patchState((s) => {
        s.todos = [];
      });
    }),
  )
  .render(({ rpc }) => ({ rpc }) as unknown);

describe("testLive types", () => {
  it("exposes the exact-keyed, payload-typed rpc facade", async () => {
    const t = await testLive(route, { params: { orgId: "acme" } });

    expectTypeOf(t.rpc.add).parameter(0).toEqualTypeOf<{ text: string }>();
    expectTypeOf(t.rpc.add).returns.toEqualTypeOf<Promise<void>>();
    // @ts-expect-error — no such rpc on this route
    void t.rpc.nope;
    // @ts-expect-error — wrong payload shape
    void t.rpc.add({ text: 1 });

    expectTypeOf(t.state.todos).toEqualTypeOf<{ id: string; text: string }[]>();
    expectTypeOf(t.state.orgId).toEqualTypeOf<string>();
  });

  it("requires path params matching the route literal", async () => {
    // @ts-expect-error — orgId is required for this path
    void testLive(route, { params: {} });
  });
});
