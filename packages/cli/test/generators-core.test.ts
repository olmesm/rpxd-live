import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyPlan } from "../src/generators/apply.ts";
import { detectFeatures } from "../src/generators/detect.ts";
import { parseFields } from "../src/generators/fields.ts";
import {
  camelCase,
  kebabCase,
  pascalCase,
  pluralize,
  routePlural,
  singularize,
} from "../src/generators/names.ts";

describe("parseFields (Phoenix-style field:type)", () => {
  it("maps every supported type to prisma + ts", () => {
    const fields = parseFields([
      "title:string",
      "body:text",
      "done:boolean",
      "count:int",
      "rating:float",
      "due:datetime",
    ]);
    expect(fields).toEqual([
      { name: "title", type: "string", tsType: "string", prismaType: "String" },
      { name: "body", type: "text", tsType: "string", prismaType: "String" },
      { name: "done", type: "boolean", tsType: "boolean", prismaType: "Boolean" },
      { name: "count", type: "int", tsType: "number", prismaType: "Int" },
      { name: "rating", type: "float", tsType: "number", prismaType: "Float" },
      { name: "due", type: "datetime", tsType: "Date", prismaType: "DateTime" },
    ]);
  });

  it("defaults a bare name to string", () => {
    expect(parseFields(["title"])[0]).toMatchObject({ name: "title", type: "string" });
  });

  it("maps date and json", () => {
    expect(parseFields(["due:date"])[0]).toMatchObject({
      name: "due",
      type: "date",
      tsType: "Date",
      prismaType: "DateTime",
    });
    expect(parseFields(["meta:json"])[0]).toMatchObject({
      type: "json",
      tsType: "unknown",
      prismaType: "Json",
    });
  });

  it("normalizes field names to camelCase", () => {
    expect(parseFields(["full_name:string"])[0]?.name).toBe("fullName");
    expect(parseFields(["is_active:boolean"])[0]?.name).toBe("isActive");
  });

  it("parses a references (belongs_to) field", () => {
    const [f] = parseFields(["author_id:references:User"]);
    expect(f).toMatchObject({
      name: "authorId",
      type: "references",
      tsType: "string",
      prismaType: "String",
      reference: { model: "User", relationName: "author" },
    });
  });

  it("derives the FK when references omits the _id suffix", () => {
    const [f] = parseFields(["author:references:User"]);
    expect(f).toMatchObject({ name: "authorId", reference: { relationName: "author" } });
  });

  it("rejects a references field without a target model", () => {
    expect(() => parseFields(["author_id:references"])).toThrow(/needs a model/);
  });

  it("rejects an unknown type", () => {
    expect(() => parseFields(["title:wat"])).toThrow(/unknown field type "wat"/);
  });

  it("rejects field names that collide with generated columns", () => {
    expect(() => parseFields(["id:string"])).toThrow(/collides with a generated column/);
    expect(() => parseFields(["owner:string"])).toThrow(/generated column/);
    expect(() => parseFields(["created:datetime"])).toThrow(/generated column/);
  });

  it("rejects field names that aren't valid identifiers", () => {
    expect(() => parseFields(["2fa:string"])).toThrow(/not a valid identifier/);
    expect(() => parseFields(["_:string"])).toThrow(/not a valid identifier/);
  });
});

describe("name helpers", () => {
  it("pascalCase / camelCase / kebabCase", () => {
    expect(pascalCase("todo_items")).toBe("TodoItems");
    expect(camelCase("TodoItems")).toBe("todoItems");
    expect(kebabCase("TodoItems")).toBe("todo-items");
  });
  it("pluralize / singularize (simple)", () => {
    expect(pluralize("todo")).toBe("todos");
    expect(pluralize("note")).toBe("notes");
    expect(singularize("todos")).toBe("todo");
  });

  it("routePlural normalizes + guarantees plural, idempotently", () => {
    // already-plural args stay put (no double-pluralize)
    expect(routePlural("todos")).toBe("todos");
    expect(routePlural("Posts")).toBe("posts");
    // singular args become plural
    expect(routePlural("todo")).toBe("todos");
    // messy input → clean camelCase token
    expect(routePlural("blog posts")).toBe("blogPosts");
    expect(routePlural("blog_post")).toBe("blogPosts");
  });
});

describe("detectFeatures", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "rpxd-detect-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("reports no auth / no db in an empty project", () => {
    expect(detectFeatures(root)).toEqual({ hasDb: false, hasAuth: false });
  });

  it("detects db and auth adapters", () => {
    const adapters = join(root, "adapters");
    require("node:fs").mkdirSync(adapters, { recursive: true });
    writeFileSync(join(adapters, "db.ts"), "");
    writeFileSync(join(adapters, "auth.ts"), "");
    expect(detectFeatures(root)).toEqual({ hasDb: true, hasAuth: true });
  });
});

describe("applyPlan (no-clobber fs shell)", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "rpxd-apply-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("writes nested files and reports them", () => {
    const res = applyPlan(
      root,
      { files: [{ path: "routes/index.tsx", contents: "hi" }], steps: [], commands: [] },
      {},
    );
    expect(res.written).toEqual(["routes/index.tsx"]);
    expect(readFileSync(join(root, "routes/index.tsx"), "utf-8")).toBe("hi");
  });

  it("never overwrites an existing file without force", () => {
    writeFileSync(join(root, "keep.txt"), "original");
    const res = applyPlan(
      root,
      { files: [{ path: "keep.txt", contents: "new" }], steps: [], commands: [] },
      {},
    );
    expect(res.skipped).toEqual(["keep.txt"]);
    expect(res.written).toEqual([]);
    expect(readFileSync(join(root, "keep.txt"), "utf-8")).toBe("original");
  });

  it("overwrites with force", () => {
    writeFileSync(join(root, "keep.txt"), "original");
    const res = applyPlan(
      root,
      { files: [{ path: "keep.txt", contents: "new" }], steps: [], commands: [] },
      { force: true },
    );
    expect(res.written).toEqual(["keep.txt"]);
    expect(readFileSync(join(root, "keep.txt"), "utf-8")).toBe("new");
  });

  it("is idempotent: unchanged content is skipped, not rewritten", () => {
    applyPlan(root, { files: [{ path: "a.txt", contents: "same" }], steps: [], commands: [] }, {});
    const res = applyPlan(
      root,
      { files: [{ path: "a.txt", contents: "same" }], steps: [], commands: [] },
      { force: true },
    );
    expect(res.skipped).toEqual(["a.txt"]);
    expect(existsSync(join(root, "a.txt"))).toBe(true);
  });

  it("appends a block to an existing file when the marker is absent", () => {
    writeFileSync(join(root, "schema.prisma"), "datasource db {}\n");
    const res = applyPlan(
      root,
      {
        files: [],
        appends: [{ path: "schema.prisma", marker: "model Post ", content: "model Post {\n}" }],
        steps: [],
        commands: [],
      },
      {},
    );
    expect(res.appended).toEqual(["schema.prisma"]);
    expect(readFileSync(join(root, "schema.prisma"), "utf-8")).toContain("model Post {");
  });

  it("skips the append when the marker is already present (idempotent)", () => {
    writeFileSync(join(root, "schema.prisma"), "model Post {\n  id String @id\n}\n");
    const res = applyPlan(
      root,
      {
        files: [],
        appends: [{ path: "schema.prisma", marker: "model Post ", content: "model Post {\n}" }],
        steps: [],
        commands: [],
      },
      {},
    );
    expect(res.appended).toEqual([]);
    expect(res.appendSkipped).toEqual(["schema.prisma"]);
  });

  it("skips the append (never creates) when the target file is missing", () => {
    const res = applyPlan(
      root,
      {
        files: [],
        appends: [{ path: "schema.prisma", marker: "model Post ", content: "x" }],
        steps: [],
        commands: [],
      },
      {},
    );
    expect(res.appendSkipped).toEqual(["schema.prisma"]);
    expect(existsSync(join(root, "schema.prisma"))).toBe(false);
  });
});
