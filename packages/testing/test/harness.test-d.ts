/**
 * Type tests for the testing harness: `t.rpc.*` carries the route's exact
 * rpc record — same keys, same payloads as the component's facade (§5).
 */
import { live } from "@rpxd/core";
import { describe, expectTypeOf, it } from "vitest";
import { z } from "zod";
import { testLive } from "../src/index.ts";

const route = live("/org/$orgId")
  .setup((ctx) => ({ orgId: ctx.params.orgId, todos: [] as { id: string; text: string }[] }))
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

const widget = live("/widget/$id", z.object({ variant: z.enum(["compact", "full"]) }))
  .setup(() => ({ variant: "" as "compact" | "full" | "" }))
  .load(({ props }, ctx) => {
    ctx.patchState((s) => {
      s.variant = props.variant;
    });
  })
  .render(() => null);

describe("testLive props typing (ADR 0002 item 15)", () => {
  it("types the `props` option from the route's schema output", async () => {
    void testLive(widget, { params: { id: "1" }, props: { variant: "compact" } });
    // @ts-expect-error — "wide" is not a valid variant
    void testLive(widget, { params: { id: "1" }, props: { variant: "wide" } });
    // @ts-expect-error — props must match the schema output shape
    void testLive(widget, { params: { id: "1" }, props: { nope: "x" } });
  });

  it("types the `patchProps` arg from the route's schema output", async () => {
    const t = await testLive(widget, { params: { id: "1" }, props: { variant: "compact" } });
    expectTypeOf(t.patchProps).parameter(0).toEqualTypeOf<{ variant: "compact" | "full" }>();
    await t.patchProps({ variant: "full" });
    // @ts-expect-error — "wide" is not a valid variant
    void t.patchProps({ variant: "wide" });
  });

  it("keeps a loose record for a schema-less route (back-compat)", async () => {
    const schemaless = live("/plain")
      .setup(() => ({ q: "" }))
      .load(({ props }, ctx) => {
        ctx.patchState((s) => {
          s.q = props.filter ?? "";
        });
      })
      .render(() => null);
    const t = await testLive(schemaless, { props: { filter: "done" } });
    // schema-less: any string-keyed record is accepted (raw query semantics)
    await t.patchProps({ anything: "goes" });
    await t.navigate({ filter: "open" });
  });
});
