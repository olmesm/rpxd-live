/**
 * Type tests for live()'s public API (spec §1, §5, §7).
 *
 * Contract locked here (TS 6.0):
 * - Path literals drive `PathParams` and mount/ctx typing.
 * - `mount`'s return type is the single source of truth for state: `on`
 *   handlers and the params reducer infer from it without annotations.
 * - Rpc reducer *parameters* require explicit annotations (both forms) —
 *   TypeScript cannot contextually type them through the plain/generator
 *   union, and reverse-mapped payload inference from `input` schemas is not
 *   reliable on current TS. `InferOutput<Schema>` keeps annotations DRY.
 */
import type { Draft } from "immer";
import { describe, expectTypeOf, it } from "vitest";
import { z } from "zod";
import { type LiveRoute, live, type PathParams, type RpcCtx } from "../src/live.ts";
import type { InferOutput } from "../src/standard-schema.ts";

interface Project {
  id: string;
  name: string;
}
interface BoardState {
  projects: Project[];
  importing: boolean;
}
type BoardDraft = Draft<BoardState>;

describe("PathParams (§7)", () => {
  it("extracts $params from path literals", () => {
    expectTypeOf<PathParams<"/org/$orgId/board">>().toEqualTypeOf<{ orgId: string }>();
    expectTypeOf<PathParams<"/a/$x/b/$y">>().toEqualTypeOf<{ x: string; y: string }>();
    expectTypeOf<PathParams<"/">>().toEqualTypeOf<Record<never, string>>();
    expectTypeOf<PathParams<"/static/only">>().toEqualTypeOf<Record<never, string>>();
  });
});

describe("live() inference (§1)", () => {
  it("types mount params from the path literal and infers state", () => {
    const route = live("/org/$orgId/board")({
      mount: async ({ orgId }, ctx) => {
        expectTypeOf(orgId).toEqualTypeOf<string>();
        expectTypeOf(ctx.subscribe).parameter(0).toEqualTypeOf<string>();
        return { projects: [] as Project[], importing: false };
      },
    })(null);
    expectTypeOf(route.path).toEqualTypeOf<"/org/$orgId/board">();
    expectTypeOf(route).toMatchTypeOf<
      LiveRoute<
        { projects: Project[]; importing: boolean },
        "/org/$orgId/board",
        Record<string, unknown>,
        null
      >
    >();
  });

  it("rejects mount params not present in the path literal", () => {
    live("/org/$orgId/board")({
      // @ts-expect-error — $teamId is not a param of this path
      mount: async ({ teamId }: { teamId: string }) => ({ teamId }),
    });
  });

  it("types the params reducer session draft and search without annotations (§7)", () => {
    live("/")({
      mount: async () => ({ projects: [] as Project[] }),
      params: (session, search) => {
        expectTypeOf(search).toEqualTypeOf<Record<string, string | undefined>>();
        session.filter = search.filter ?? "all"; // session is a mutable draft
      },
    });
  });

  it("types on-handlers' state as a draft of the mount state without annotations (§8)", () => {
    live("/")({
      mount: async () => ({ projects: [] as Project[] }),
      on: {
        "project.created": (state, _payload, ctx) => {
          expectTypeOf(state).toEqualTypeOf<Draft<{ projects: Project[] }>>();
          expectTypeOf(ctx.broadcast).parameter(0).toEqualTypeOf<string>();
          state.projects.push({ id: "1", name: "x" });
        },
      },
    });
  });
});

describe("rpc declarations (§5)", () => {
  const createInput = z.object({ name: z.string(), count: z.number() });
  type CreatePayload = InferOutput<typeof createInput>;

  it("InferOutput derives payload types from Standard Schemas", () => {
    expectTypeOf<CreatePayload>().toEqualTypeOf<{ name: string; count: number }>();
  });

  it("accepts the long form with annotated reducer params", () => {
    live("/org/$orgId/board")({
      mount: async () => ({ projects: [] as Project[], importing: false }),
      rpc: {
        create: {
          input: createInput,
          optimistic: (state: BoardState, payload: CreatePayload, ctx) => {
            expectTypeOf(ctx.tempId()).toEqualTypeOf<string>();
            state.projects.push({ id: ctx.tempId(), name: payload.name });
          },
          async handler(
            state: BoardDraft,
            payload: CreatePayload,
            ctx: RpcCtx<{ orgId: string }, Record<string, unknown>>,
          ) {
            expectTypeOf(ctx.params.orgId).toEqualTypeOf<string>();
            expectTypeOf(ctx.resolveId).parameter(0).toEqualTypeOf<string>();
            state.projects.push({ id: "srv", name: payload.name });
          },
          onError(state: BoardDraft, error, payload: CreatePayload) {
            expectTypeOf(error).toEqualTypeOf<unknown>();
            state.importing = false;
            void payload.name;
          },
        },
      },
    });
  });

  it("accepts generator long-form handlers with annotated getState (§3)", () => {
    live("/")({
      mount: async () => ({ projects: [] as Project[], importing: false }),
      rpc: {
        stream: {
          input: z.object({ url: z.string() }),
          async *handler(getState: () => BoardDraft, payload: { url: string }) {
            expectTypeOf(getState()).toEqualTypeOf<BoardDraft>();
            getState().importing = true;
            yield;
            void payload.url;
            getState().importing = false;
          },
        },
      },
    });
  });

  it("keeps annotated short-form reducers valid (§5)", () => {
    live("/")({
      mount: async () => ({ projects: [] as Project[], importing: false }),
      rpc: {
        async add(state: BoardDraft, payload: { name: string }) {
          state.projects.push({ id: "1", name: payload.name });
        },
        async *streamShort(getState: () => BoardDraft) {
          getState().projects.pop();
          yield;
        },
      },
    });
  });

  it("rejects reducers that mutate state with the wrong shape", () => {
    live("/")({
      mount: async () => ({ projects: [] as Project[] }),
      rpc: {
        async bad(state: Draft<{ projects: Project[] }>) {
          // @ts-expect-error — no such field on the mount state
          state.nope = true;
        },
      },
    });
  });

  it("rejects long forms whose handler state disagrees with mount state", () => {
    live("/")({
      mount: async () => ({ projects: [] as Project[] }),
      rpc: {
        wrong: {
          // @ts-expect-error — handler state shape is not the mount state
          async handler(state: Draft<{ other: number }>) {
            state.other = 1;
          },
        },
      },
    });
  });
});
