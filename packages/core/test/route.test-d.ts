/**
 * Type tests for the fluent route() API (the routes & auth guide).
 *
 * Contract: path params are typed from the literal; handlers get
 * `(req, ctx)` with a `Response`-returning shape; each method returns the
 * same chainable `RouteObject` so no terminal call is needed.
 */
import { describe, expectTypeOf, it } from "vitest";
import { type RouteObject, route } from "../src/route.ts";

describe("route() typing", () => {
  it("evaluates to a chainable RouteObject with the path literal", () => {
    const r = route("/api/webhooks/stripe").post((req, ctx) => {
      expectTypeOf(req).toEqualTypeOf<Request>();
      expectTypeOf(ctx.sid).toEqualTypeOf<string>();
      expectTypeOf(ctx.session).toEqualTypeOf<unknown>();
      return new Response(null);
    });
    expectTypeOf(r).toMatchTypeOf<RouteObject<"/api/webhooks/stripe">>();
  });

  it("types $name path params from the literal", () => {
    route("/hook/$id").get((_req, ctx) => {
      expectTypeOf(ctx.params).toEqualTypeOf<{ id: string }>();
      return new Response(null);
    });
  });

  it("allows async handlers and chaining", () => {
    const r = route("/api/thing")
      .get(() => new Response("g"))
      .post(async () => new Response("p"));
    expectTypeOf(r).toMatchTypeOf<RouteObject<"/api/thing">>();
  });
});
