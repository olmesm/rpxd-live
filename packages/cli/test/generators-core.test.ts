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

  it("rejects an unknown type", () => {
    expect(() => parseFields(["title:wat"])).toThrow(/unknown field type "wat"/);
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
});
