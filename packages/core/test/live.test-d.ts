/**
 * Type tests for the fluent live() API (spec §1, §3, §5, §7).
 *
 * Contract: ZERO annotations anywhere. State locks at `.mount()`, payloads
 * lock at `.input()` (or the reducer's own annotation), the rpc name/payload
 * record accumulates across `.rpc()` calls, and `.render()` hands the
 * component fully typed props — including an exact-keyed, payload-typed
 * `rpc` facade.
 */
import type { Draft } from "immer";
import { describe, expectTypeOf, it } from "vitest";
import { z } from "zod";
import { type LiveRoute, live, type PathParams } from "../src/live.ts";
import type { RenderProps } from "../src/render-props.ts";

interface Project {
  id: string;
  name: string;
}

describe("PathParams (§7)", () => {
  it("extracts $params from path literals", () => {
    expectTypeOf<PathParams<"/org/$orgId/board">>().toEqualTypeOf<{ orgId: string }>();
    expectTypeOf<PathParams<"/a/$x/b/$y">>().toEqualTypeOf<{ x: string; y: string }>();
    expectTypeOf<PathParams<"/">>().toEqualTypeOf<Record<never, string>>();
  });
});

describe("fluent live() — full inference, no annotations (§1, §5)", () => {
  it("locks state at mount and threads it through every step", () => {
    const route = live("/org/$orgId/board")
      .mount(async ({ orgId }, ctx) => {
        expectTypeOf(orgId).toEqualTypeOf<string>();
        expectTypeOf(ctx.subscribe).parameter(0).toEqualTypeOf<string>();
        return { projects: [] as Project[], importing: false };
      })
      .rpc("create", (r) =>
        r
          .input(z.object({ name: z.string(), count: z.number() }))
          .optimistic((state, payload, ctx) => {
            expectTypeOf(state.projects).toEqualTypeOf<Project[]>();
            expectTypeOf(payload).toEqualTypeOf<{ name: string; count: number }>();
            expectTypeOf(ctx.tempId()).toEqualTypeOf<string>();
            state.projects.push({ id: ctx.tempId(), name: payload.name });
          })
          .handler(async (payload, ctx) => {
            expectTypeOf(payload).toEqualTypeOf<{ name: string; count: number }>();
            expectTypeOf(ctx.params).toEqualTypeOf<{ orgId: string }>();
            expectTypeOf(ctx.state.projects[0]?.name).toEqualTypeOf<string | undefined>();
            expectTypeOf(ctx.signal).toEqualTypeOf<AbortSignal>();
            ctx.patchState((s) => {
              expectTypeOf(s).toEqualTypeOf<Draft<{ projects: Project[]; importing: boolean }>>();
              s.projects.push({ id: "srv", name: payload.name });
            });
          })
          .onError((state, error, payload) => {
            expectTypeOf(error).toEqualTypeOf<unknown>();
            expectTypeOf(payload).toEqualTypeOf<{ name: string; count: number }>();
            state.importing = false;
          }),
      )
      .rpc("importCsv", (r) =>
        r.input(z.object({ url: z.string() })).handler(async (payload, ctx) => {
          expectTypeOf(payload.url).toEqualTypeOf<string>();
          ctx.patchState((s) => {
            s.importing = true;
          });
          ctx.patchState((s) => {
            s.importing = false;
          });
        }),
      )
      .on("project.created", (state, _payload, ctx) => {
        expectTypeOf(state).toEqualTypeOf<Draft<{ projects: Project[]; importing: boolean }>>();
        expectTypeOf(ctx.broadcast).parameter(0).toEqualTypeOf<string>();
      })
      .params((session, search) => {
        expectTypeOf(search).toEqualTypeOf<Record<string, string | undefined>>();
        session.filter = search.filter ?? "all";
      })
      .render((props) => {
        // render props fully inferred — no annotation on the component
        expectTypeOf(props.state.projects).toEqualTypeOf<Project[]>();
        expectTypeOf(props.keyOf).parameter(0).toEqualTypeOf<string | number>();
        // typed rpc facade: exact keys, exact payloads (§5 client rpc.*)
        expectTypeOf(props.rpc.create).parameter(0).toEqualTypeOf<{
          name: string;
          count: number;
        }>();
        expectTypeOf(props.rpc.importCsv).parameter(0).toEqualTypeOf<{ url: string }>();
        expectTypeOf(props.rpc.create).returns.toEqualTypeOf<Promise<void>>();
        return null;
      });

    expectTypeOf(route.path).toEqualTypeOf<"/org/$orgId/board">();
    expectTypeOf(route).toMatchTypeOf<
      LiveRoute<
        { projects: Project[]; importing: boolean },
        "/org/$orgId/board",
        Record<string, unknown>,
        unknown
      >
    >();
  });

  it("rejects unknown rpc names and wrong payloads in the component", () => {
    live("/")
      .mount(async () => ({ n: 0 }))
      .rpc("bump", (r) =>
        r.input(z.object({ by: z.number() })).handler(async (p, ctx) => {
          ctx.patchState((s) => {
            s.n += p.by;
          });
        }),
      )
      .render(({ rpc }) => {
        // @ts-expect-error — no such rpc
        void rpc.nope;
        // @ts-expect-error — wrong payload shape
        void rpc.bump({ by: "one" });
        void rpc.bump({ by: 1 });
        return null;
      });
  });

  it("types handler-only rpcs from the reducer's payload annotation", () => {
    live("/")
      .mount(async () => ({ log: [] as string[] }))
      .rpc("say", (r) =>
        r.handler(async (payload: { text: string }, ctx) => {
          ctx.patchState((s) => {
            s.log.push(payload.text);
          });
        }),
      )
      .render(({ rpc }) => {
        expectTypeOf(rpc.say).parameter(0).toEqualTypeOf<{ text: string }>();
        return null;
      });
  });

  it("infers payloads for optimistic-first chains (no input schema)", () => {
    live("/")
      .mount(async () => ({ items: [] as string[] }))
      .rpc("add", (r) =>
        r
          .optimistic((state, payload: { text: string }) => {
            state.items.push(payload.text);
          })
          .handler(async (payload, ctx) => {
            expectTypeOf(payload).toEqualTypeOf<{ text: string }>();
            ctx.patchState((s) => {
              s.items.push(payload.text);
            });
          }),
      );
  });

  it("rejects mount params not present in the path literal", () => {
    // @ts-expect-error — $teamId is not a param of this path
    live("/org/$orgId").mount(async ({ teamId }: { teamId: string }) => ({ teamId }));
  });

  it("rejects reducers that mutate state with the wrong shape", () => {
    live("/")
      .mount(async () => ({ projects: [] as Project[] }))
      .rpc("bad", (r) =>
        r.handler(async (_p, ctx) => {
          ctx.patchState((s) => {
            // @ts-expect-error — no such field on the mount state
            s.nope = true;
          });
          // @ts-expect-error — ctx.state is read-only
          ctx.state.projects = [];
        }),
      );
  });

  it("produces the standard LiveRoute def consumed by the runtime", () => {
    const route = live("/")
      .mount(async () => ({ n: 0 }))
      .version("v2")
      .rpc("bump", (r) => r.atomic().handler(async (_p, ctx) => ctx.patchState((s) => void s.n++)))
      .render(() => null);
    expectTypeOf(route.$live).toEqualTypeOf<true>();
    expectTypeOf(route.def.version).toEqualTypeOf<string | undefined>();
    expectTypeOf(route.def.rpc).not.toBeNever();
  });
});

describe("RenderProps stays explicitly usable", () => {
  it("accepts a hand-written annotation with a payload map", () => {
    type Props = RenderProps<{ n: number }, Record<string, unknown>, { bump: { by: number } }>;
    expectTypeOf<Props["rpc"]["bump"]>().parameter(0).toEqualTypeOf<{ by: number }>();
    expectTypeOf<Props["state"]>().toEqualTypeOf<{ n: number }>();
  });
});
