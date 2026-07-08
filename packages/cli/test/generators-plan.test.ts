import { describe, expect, it } from "vitest";
import { planAuth } from "../src/generators/auth.ts";
import { planInit } from "../src/generators/init.ts";
import { planScaffold } from "../src/generators/scaffold.ts";
import type { GeneratorPlan } from "../src/generators/types.ts";

const paths = (plan: GeneratorPlan) => plan.files.map((f) => f.path);
const file = (plan: GeneratorPlan, path: string) =>
  plan.files.find((f) => f.path === path)?.contents ?? "";

describe("planInit", () => {
  it("scaffolds the full auth+db tree by default", () => {
    const plan = planInit({ name: "my-app", auth: true, db: true });
    const p = paths(plan);
    expect(p).toEqual(
      expect.arrayContaining([
        "package.json",
        "tsconfig.json",
        "rpxd.config.ts",
        "routes/__root.tsx",
        "routes/index.tsx",
        "domain/scope.ts",
        "adapters/db.ts",
        "adapters/auth.ts",
        "prisma/schema.prisma",
        "routes/login.tsx",
        "routes/account.tsx",
        "routes/api.auth.$.ts",
      ]),
    );
    expect(file(plan, "rpxd.config.ts")).toContain("authenticate");
    expect(file(plan, "package.json")).toContain("better-auth");
    expect(file(plan, "prisma/schema.prisma")).toContain("model User");
    expect(plan.commands).toContain("bun run setup");
  });

  it("--no-auth keeps db but drops auth wiring", () => {
    const plan = planInit({ name: "my-app", auth: false, db: true });
    const p = paths(plan);
    expect(p).toContain("adapters/db.ts");
    expect(p).not.toContain("adapters/auth.ts");
    expect(p).not.toContain("routes/login.tsx");
    expect(file(plan, "rpxd.config.ts")).not.toContain("authenticate");
    expect(file(plan, "package.json")).not.toContain("better-auth");
    expect(file(plan, "prisma/schema.prisma")).not.toContain("model User");
  });

  it("--no-db strips db and forces auth off, with a note", () => {
    const plan = planInit({ name: "my-app", auth: true, db: false });
    const p = paths(plan);
    expect(p).not.toContain("adapters/db.ts");
    expect(p).not.toContain("adapters/auth.ts");
    expect(p).not.toContain("prisma/schema.prisma");
    expect(plan.commands).not.toContain("bun run setup");
    expect(plan.steps.join("\n")).toMatch(/Auth needs a database/);
  });
});

describe("planScaffold", () => {
  const noFeatures = { hasDb: false, hasAuth: false };

  it("emits a live page + in-memory domain + testLive route test (no db)", () => {
    const plan = planScaffold({
      context: "Todos",
      schema: "Todo",
      plural: "todos",
      fieldSpecs: ["text:string", "done:boolean"],
      features: noFeatures,
    });
    expect(paths(plan)).toEqual(["routes/todos.tsx", "domain/todos.ts", "test/todos.test.ts"]);
    const route = file(plan, "routes/todos.tsx");
    expect(route).toContain('live("/todos")');
    expect(route).toContain("rpc.toggle"); // boolean field → toggle
    expect(file(plan, "domain/todos.ts")).toContain("new Map");
    const test = file(plan, "test/todos.test.ts");
    expect(test).toContain("testLive");
    expect(test).toContain("t.rpc.create");
    expect(test).toContain("t.rpc.toggle"); // boolean field → toggle exercised
    expect(plan.appends ?? []).toHaveLength(0); // no db → nothing to append
  });

  it("uses a Prisma-backed domain and appends the model when the app has a db", () => {
    const plan = planScaffold({
      context: "Notes",
      schema: "Note",
      plural: "notes",
      fieldSpecs: ["title:string"],
      features: { hasDb: true, hasAuth: false },
    });
    expect(file(plan, "domain/notes.ts")).toContain("import.meta.env.SSR");
    // model is appended to schema.prisma (not printed for pasting)
    const append = (plan.appends ?? [])[0];
    expect(append?.path).toBe("prisma/schema.prisma");
    expect(append?.marker).toBe("model Note ");
    expect(append?.content).toContain("model Note {");
    expect(plan.commands).toContain("bunx prisma format");
    expect(plan.commands).toContain("bun run db:push");
  });

  it("references field → FK + @relation + @@index in the appended model", () => {
    const plan = planScaffold({
      context: "Posts",
      schema: "Post",
      plural: "posts",
      fieldSpecs: ["title:string", "author_id:references:User"],
      features: { hasDb: true, hasAuth: true },
    });
    const model = (plan.appends ?? [])[0]?.content ?? "";
    expect(model).toMatch(/authorId\s+String/);
    expect(model).toContain("@relation(fields: [authorId], references: [id])");
    expect(model).toContain("@@index([authorId])");
    // row/input types carry the FK as a plain string
    expect(file(plan, "domain/posts.ts")).toContain("authorId: string");
    // prisma format completes the inverse relation
    expect(plan.steps.join("\n")).toMatch(/prisma format/);
  });

  it("--protected adds a mount gate on an auth app", () => {
    const plan = planScaffold({
      context: "Todos",
      schema: "Todo",
      plural: "todos",
      fieldSpecs: ["text:string"],
      protectedRoute: true,
      features: { hasDb: true, hasAuth: true },
    });
    const route = file(plan, "routes/todos.tsx");
    expect(route).toContain('redirect("/login")');
    expect(route).toContain("live, redirect");
  });

  it("ignores --protected without auth and says so", () => {
    const plan = planScaffold({
      context: "Todos",
      schema: "Todo",
      plural: "todos",
      fieldSpecs: ["text:string"],
      protectedRoute: true,
      features: noFeatures,
    });
    expect(file(plan, "routes/todos.tsx")).not.toContain("redirect");
    expect(plan.steps.join("\n")).toMatch(/Ignored --protected/);
  });

  it("--kind http emits a route() endpoint and no toggle", () => {
    const plan = planScaffold({
      context: "Todos",
      schema: "Todo",
      plural: "todos",
      fieldSpecs: ["text:string"],
      kind: "http",
      features: noFeatures,
    });
    expect(paths(plan)).toContain("routes/todos.ts");
    expect(file(plan, "routes/todos.ts")).toContain('route("/api/todos")');
    // http has no rpcs → a domain test, not a testLive route test
    expect(paths(plan)).toContain("domain/todos.test.ts");
  });

  it("--no-test drops the test file", () => {
    const plan = planScaffold({
      context: "Todos",
      schema: "Todo",
      plural: "todos",
      fieldSpecs: ["text:string"],
      test: false,
      features: noFeatures,
    });
    expect(paths(plan).some((p) => p.endsWith(".test.ts"))).toBe(false);
  });
});

describe("planAuth", () => {
  it("writes db + auth files when the app has no db, and prints the config hook", () => {
    const plan = planAuth({ features: { hasDb: false, hasAuth: false } });
    const p = paths(plan);
    expect(p).toContain("adapters/db.ts");
    expect(p).toContain("adapters/auth.ts");
    expect(p).toContain("routes/api.auth.$.ts");
    expect(plan.steps.join("\n")).toContain("authenticate");
    expect(plan.commands.join(" ")).toContain("better-auth");
  });

  it("does not rewrite an existing db, printing the adapter + models instead", () => {
    const plan = planAuth({ features: { hasDb: true, hasAuth: false } });
    expect(paths(plan)).not.toContain("adapters/db.ts");
    expect(paths(plan)).not.toContain("prisma/schema.prisma");
    const steps = plan.steps.join("\n");
    expect(steps).toContain("prismaAdapter");
    expect(steps).toContain("model User");
  });
});
