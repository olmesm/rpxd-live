import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyPlan } from "../src/generators/apply.ts";
import { detectFeatures } from "../src/generators/detect.ts";
import { parseFields } from "../src/generators/fields.ts";
import { camelCase, kebabCase, pascalCase, routePlural } from "../src/generators/names.ts";
import { appShellFiles } from "../src/generators/templates/app.ts";

const fileOf = (db: boolean, path: string): string =>
  appShellFiles({ name: "x", db, auth: db }).find((f) => f.path === path)?.contents ?? "";

describe("scaffolded Dockerfile + ignores", () => {
  it("db variant: applies the schema, execs into rpxd, and warns about ephemeral sqlite", () => {
    const dockerfile = fileOf(true, "Dockerfile");
    expect(dockerfile).toContain("bun run db:generate && bun run build");
    expect(dockerfile).toContain("exec bun run start"); // exec → rpxd gets SIGTERM
    expect(dockerfile).toContain("mount a volume at /app/prisma"); // persistence footgun noted
  });

  it("non-db variant: plain start, no db:push or exec shell", () => {
    const dockerfile = fileOf(false, "Dockerfile");
    expect(dockerfile).toContain('CMD ["bun", "run", "start"]');
    expect(dockerfile).not.toContain("db:push");
    expect(dockerfile).not.toContain("exec");
  });

  it("ignores .env from git and the docker build context (no baked secrets)", () => {
    for (const path of [".gitignore", ".dockerignore"]) {
      expect(fileOf(true, path)).toContain(".env");
    }
  });
});

describe("parseFields (field:type)", () => {
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

  it("parses a references (foreign-key) field", () => {
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

  it("rejects duplicate field names (post-normalization)", () => {
    // Two `title`s would emit `title: string; title: boolean;` (TS2300) and a
    // Prisma model with two `title` columns.
    expect(() => parseFields(["title:string", "title:boolean"])).toThrow(/duplicate field/i);
    // camelCase normalization means these collide too.
    expect(() => parseFields(["full_name:string", "fullName:string"])).toThrow(/duplicate field/i);
  });

  it("rejects a relation name that collides with a sibling scalar field", () => {
    // `author_id:references:User` derives relation `author` — alongside
    // `author:string` the model would carry both `author String` and
    // `author User @relation(...)`, which Prisma rejects.
    expect(() => parseFields(["author:string", "author_id:references:User"])).toThrow(
      /duplicate field "author"/,
    );
    // order-independent: the scalar can arrive after the relation too
    expect(() => parseFields(["author_id:references:User", "author:string"])).toThrow(
      /duplicate field "author"/,
    );
  });

  it("rejects two references fields deriving the same relation name", () => {
    // `author` and `author_id` both derive fk `authorId` + relation `author`.
    expect(() => parseFields(["author:references:User", "author_id:references:Person"])).toThrow(
      /duplicate field/i,
    );
  });

  it("rejects a references relation name that collides with a generated column", () => {
    // owner_id -> fk `ownerId` (fine) but relation `owner`, which collides with
    // the always-present `owner` column.
    expect(() => parseFields(["owner_id:references:User"])).toThrow(/generated column/);
  });

  it("rejects a field type that shadows an Object.prototype member", () => {
    // SCALARS is a plain object, so `SCALARS["toString"]`/`["constructor"]` used
    // to resolve to inherited functions and slip past the unknown-type guard.
    expect(() => parseFields(["x:toString"])).toThrow(/unknown field type/);
    expect(() => parseFields(["x:constructor"])).toThrow(/unknown field type/);
  });
});

describe("name helpers", () => {
  it("pascalCase / camelCase / kebabCase", () => {
    expect(pascalCase("todo_items")).toBe("TodoItems");
    expect(camelCase("TodoItems")).toBe("todoItems");
    expect(kebabCase("TodoItems")).toBe("todo-items");
  });
  it("routePlural normalizes casing but never re-pluralizes the user's plural", () => {
    expect(routePlural("todos")).toBe("todos");
    expect(routePlural("Posts")).toBe("posts");
    // messy input → clean camelCase token
    expect(routePlural("blog posts")).toBe("blogPosts");
    // an explicitly supplied irregular plural is the plural — verbatim
    expect(routePlural("people")).toBe("people");
    expect(routePlural("children")).toBe("children");
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
