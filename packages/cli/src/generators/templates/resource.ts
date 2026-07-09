/**
 * Templates for `rpxd scaffold <Context> <Schema> <plural> [field:type…]` — a
 * resource: a live (or HTTP) route, a scoped domain module, a
 * test, and (printed, never written) the Prisma model. The domain layer is
 * Prisma-backed when the app has `adapters/db.ts`, otherwise an in-memory store
 * so a db-less app stays runnable.
 */
import type { Field } from "../fields.ts";
import { camelCase, pascalCase } from "../names.ts";
import type { FileWrite } from "../types.ts";

/** Everything a resource template needs, derived from the CLI args + project. */
export interface ResourceSpec {
  /** Context module name, PascalCase (e.g. `Todos`). */
  context: string;
  /** Schema (singular) name, PascalCase (e.g. `Todo`). */
  schema: string;
  /** Plural, lowercase — the route path and table (e.g. `todos`). */
  plural: string;
  /** Parsed schema fields (id is implicit). */
  fields: Field[];
  /** App has a Prisma db adapter → Prisma-backed domain. */
  hasDb: boolean;
  /** App has an auth adapter → user-scoped, `--protected` available. */
  hasAuth: boolean;
  /** Generate a protected page (mount gate → `/login`). */
  protectedRoute: boolean;
  /** `page` → a live route (`.tsx`); `http` → a `route()` endpoint (`.ts`). */
  kind: "page" | "http";
}

/** Names derived once and threaded through the templates. */
interface Names {
  domainFile: string;
  listFn: string;
  createFn: string;
  removeFn: string;
  toggleFn: string;
  rowType: string;
  inputType: string;
  /** First string/text field — the display + form field. */
  display: Field | undefined;
  /** First boolean field — drives an optional toggle rpc. */
  toggleField: Field | undefined;
}

function namesOf(spec: ResourceSpec): Names {
  return {
    domainFile: camelCase(spec.context),
    listFn: `list${pascalCase(spec.plural)}`,
    createFn: `create${spec.schema}`,
    removeFn: `remove${spec.schema}`,
    toggleFn: `toggle${spec.schema}`,
    rowType: `${spec.schema}Row`,
    inputType: `New${spec.schema}Input`,
    display: spec.fields.find((f) => f.type === "string" || f.type === "text"),
    toggleField: spec.fields.find((f) => f.type === "boolean"),
  };
}

/** A literal default per field type, used for optimistic rows + form input. */
function defaultFor(field: Field): string {
  switch (field.type) {
    case "boolean":
      return "false";
    case "int":
    case "float":
      return "0";
    case "datetime":
    case "date":
      return "new Date()";
    case "json":
      return "{}";
    default:
      return '""';
  }
}

/**
 * Render `name: type;` lines. `jsonAs` overrides the TS type of `json` fields —
 * a row reads Prisma's `JsonValue` (assignable to `unknown`), but a create input
 * must be `Prisma.InputJsonValue`, so the two differ in the Prisma variant.
 */
const fieldLines = (fields: Field[], jsonAs?: string, indent = "  "): string =>
  fields
    .map((f) => `${indent}${f.name}: ${f.type === "json" && jsonAs ? jsonAs : f.tsType};`)
    .join("\n");

/** Whether any field is a `json` — drives the `Prisma` type import in the db variant. */
const hasJson = (fields: Field[]): boolean => fields.some((f) => f.type === "json");

// ── Domain modules ──────────────────────────────────────────────────────────

function memoryDomain(spec: ResourceSpec, n: Names): string {
  const toggle = n.toggleField
    ? `
/** Toggle a scoped row's \`${n.toggleField.name}\`; returns it, or undefined if absent. */
export async function ${n.toggleFn}(scope: Scope, id: string): Promise<${n.rowType} | undefined> {
  const rows = store.get(ownerOf(scope));
  const row = rows?.find((r) => r.id === id);
  if (!row) return undefined;
  row.${n.toggleField.name} = !row.${n.toggleField.name};
  return row;
}
`
    : "";
  return `/**
 * ${spec.context} domain module — the service-layer boundary.
 * \`routes/\` calls these; nothing else touches the store. In-memory (no db
 * wired) — swap the \`store\` Map for Prisma once you add \`adapters/db.ts\`.
 * Queries scope by {@link Scope}: a signed-in user by \`user.id\`, else \`sid\`.
 */
import type { Scope } from "./scope";

/** A persisted ${spec.schema} row. */
export interface ${n.rowType} {
  id: string;
${fieldLines(spec.fields)}
}

/** Fields accepted when creating a ${spec.schema}. */
export type ${n.inputType} = {
${fieldLines(spec.fields)}
};

const store = new Map<string, ${n.rowType}[]>();
const ownerOf = (scope: Scope): string => scope.user?.id ?? scope.sid;

/** Load every ${spec.schema} in scope (insertion order). */
export async function ${n.listFn}(scope: Scope): Promise<${n.rowType}[]> {
  return [...(store.get(ownerOf(scope)) ?? [])];
}

/** Create a ${spec.schema} in scope; returns the persisted row. */
export async function ${n.createFn}(scope: Scope, input: ${n.inputType}): Promise<${n.rowType}> {
  const row: ${n.rowType} = { id: crypto.randomUUID(), ...input };
  const owner = ownerOf(scope);
  store.set(owner, [...(store.get(owner) ?? []), row]);
  return row;
}

/** Remove a scoped ${spec.schema} by id. */
export async function ${n.removeFn}(scope: Scope, id: string): Promise<void> {
  const owner = ownerOf(scope);
  store.set(owner, (store.get(owner) ?? []).filter((r) => r.id !== id));
}
${toggle}`;
}

function prismaDomain(spec: ResourceSpec, n: Names): string {
  const selectFields = ["id", ...spec.fields.map((f) => f.name)]
    .map((f) => `${f}: true`)
    .join(", ");
  const toggle = n.toggleField
    ? `
/** Toggle a scoped row's \`${n.toggleField.name}\`; returns the updated row, or undefined. */
export async function ${n.toggleFn}(scope: Scope, id: string): Promise<${n.rowType} | undefined> {
  const db = await client();
  const row = await db.${camelCase(spec.schema)}.findFirst({
    where: { id, owner: ownerOf(scope) },
    select: { ${n.toggleField.name}: true },
  });
  if (!row) return undefined;
  return db.${camelCase(spec.schema)}.update({
    where: { id },
    data: { ${n.toggleField.name}: !row.${n.toggleField.name} },
    select,
  });
}
`
    : "";
  const prismaImport = hasJson(spec.fields)
    ? '\nimport type { Prisma } from "../generated/prisma/client";'
    : "";
  return `/**
 * ${spec.context} domain module — the service-layer boundary.
 * \`routes/\` calls these; only the domain layer touches \`db\`. Prisma is loaded
 * lazily + server-only (\`import.meta.env.SSR\` is a static \`false\` in the client
 * build, so it tree-shakes out). Queries scope by {@link Scope}.
 */
import type { Scope } from "./scope";${prismaImport}

/** A persisted ${spec.schema} row (the subset the UI needs). */
export interface ${n.rowType} {
  id: string;
${fieldLines(spec.fields)}
}

/** Fields accepted when creating a ${spec.schema}. */
export type ${n.inputType} = {
${fieldLines(spec.fields, "Prisma.InputJsonValue")}
};

const select = { ${selectFields} } as const;

const client = () => {
  if (import.meta.env.SSR) return import("../adapters/db").then((m) => m.db);
  throw new Error("db access is server-only");
};

const ownerOf = (scope: Scope): string => scope.user?.id ?? scope.sid;

/** Load every ${spec.schema} in scope (oldest first). */
export async function ${n.listFn}(scope: Scope): Promise<${n.rowType}[]> {
  const db = await client();
  return db.${camelCase(spec.schema)}.findMany({
    where: { owner: ownerOf(scope) },
    orderBy: { created: "asc" },
    select,
  });
}

/** Create a ${spec.schema} in scope; returns the persisted row. */
export async function ${n.createFn}(scope: Scope, input: ${n.inputType}): Promise<${n.rowType}> {
  const db = await client();
  return db.${camelCase(spec.schema)}.create({ data: { owner: ownerOf(scope), ...input }, select });
}

/** Remove a scoped ${spec.schema} by id. */
export async function ${n.removeFn}(scope: Scope, id: string): Promise<void> {
  const db = await client();
  await db.${camelCase(spec.schema)}.deleteMany({ where: { id, owner: ownerOf(scope) } });
}
${toggle}`;
}

// ── Routes ──────────────────────────────────────────────────────────────────

function pageRoute(spec: ResourceSpec, n: Names): string {
  const inputLiteral = `{ ${spec.fields
    .map((f) => (f === n.display ? `${f.name}: text` : `${f.name}: ${defaultFor(f)}`))
    .join(", ")} }`;
  const imports = [n.listFn, n.createFn, n.removeFn, ...(n.toggleField ? [n.toggleFn] : [])]
    .sort()
    .join(", ");
  const toggleRpc = n.toggleField
    ? `
  .rpc("toggle", (r) =>
    r
      .optimistic((state, { id }: { id: string }) => {
        const row = state.rows.find((x) => x.id === id);
        if (row) row.${n.toggleField.name} = !row.${n.toggleField.name};
      })
      .handler(async ({ id }, ctx) => {
        await ${n.toggleFn}(scopeFrom(ctx.session), id);
        ctx.patchState((s) => {
          const row = s.rows.find((x) => x.id === id);
          if (row) row.${n.toggleField.name} = !row.${n.toggleField.name};
        });
      }),
  )`
    : "";
  const mountBody = spec.protectedRoute
    ? `async (_params, ctx) => {
    const scope = scopeFrom(ctx.session);
    if (!scope.user) throw redirect("/login");
    return { rows: await ${n.listFn}(scope) };
  }`
    : `async (_params, ctx) => ({ rows: await ${n.listFn}(scopeFrom(ctx.session)) })`;
  const displayExpr = n.display ? `row.${n.display.name}` : "row.id";
  const toggleCell = n.toggleField
    ? `
              <input
                type="checkbox"
                checked={row.${n.toggleField.name}}
                onChange={() => void rpc.toggle({ id: row.id })}
              />`
    : "";
  const coreImport = spec.protectedRoute ? "live, redirect" : "live";

  return `import { ${coreImport} } from "@rpxd/core";
import { scopeFrom } from "../domain/scope";
import { ${imports}, type ${n.rowType} } from "../domain/${n.domainFile}";

// Generated by \`rpxd scaffold\`. Handlers stay thin: derive the scope from
// ctx.session, call the domain fn, then patchState.
export default live("/${spec.plural}")
  .mount(${mountBody})
  .rpc("create", (r) =>
    r
      .optimistic((state, { text }: { text: string }, ctx) => {
        state.rows.push({ id: ctx.tempId(), ...${inputLiteral} } satisfies ${n.rowType});
      })
      .handler(async ({ text }: { text: string }, ctx) => {
        const row = await ${n.createFn}(scopeFrom(ctx.session), ${inputLiteral});
        ctx.patchState((s) => {
          s.rows.push(row);
        });
      }),
  )
  .rpc("remove", (r) =>
    r
      .optimistic((state, { id }: { id: string }) => {
        state.rows = state.rows.filter((x) => x.id !== id);
      })
      .handler(async ({ id }, ctx) => {
        await ${n.removeFn}(scopeFrom(ctx.session), id);
        ctx.patchState((s) => {
          s.rows = s.rows.filter((x) => x.id !== id);
        });
      }),
  )${toggleRpc}
  .render(({ state, rpc, sync, keyOf }) => (
    <main>
      <h1>${spec.plural}</h1>
      <ul data-testid="${spec.plural}">
        {state.rows.map((row: ${n.rowType}) => (
          <li key={keyOf(row.id)} data-id={row.id}>${toggleCell}
            <span>{${displayExpr}}</span>
            <button type="button" onClick={() => void rpc.remove({ id: row.id })}>
              remove
            </button>
          </li>
        ))}
      </ul>
      <form
        data-testid="create-form"
        onSubmit={(e) => {
          e.preventDefault();
          const input = e.currentTarget.elements.namedItem("text") as HTMLInputElement;
          if (input.value.trim()) void rpc.create({ text: input.value.trim() });
          input.value = "";
        }}
      >
        <input name="text" placeholder="new ${spec.schema}" />
        <button type="submit">Add</button>
      </form>
      {sync.pending && <span data-testid="pending">saving…</span>}
    </main>
  ));
`;
}

function httpRoute(spec: ResourceSpec, n: Names): string {
  return `import { route } from "@rpxd/core";
import { scopeFrom } from "../domain/scope";
import { ${n.listFn} } from "../domain/${n.domainFile}";

/**
 * Generated by \`rpxd scaffold --kind http\`. A plain request/response endpoint:
 * \`ctx.session\` → scope → domain, same as a live route. Thin on purpose.
 */
export default route("/api/${spec.plural}").get(async (_req, ctx) => {
  const rows = await ${n.listFn}(scopeFrom(ctx.session));
  return Response.json(rows);
});
`;
}

// ── Tests ───────────────────────────────────────────────────────────────────

/**
 * A testLive route test — the e2e for a scaffolded page. It mounts the real
 * live object and drives its rpcs (create → toggle → remove), asserting server
 * state. Runs immediately against the in-memory domain; against a db it needs
 * `bun run setup` first (same test either way).
 */
function routeTest(spec: ResourceSpec, n: Names): string {
  const displayAssert = n.display ? `\n    expect(created.${n.display.name}).toBe("first");` : "";
  const toggleBlock = n.toggleField
    ? `
    await t.rpc.toggle({ id: created.id });
    expect(t.state.rows[0]?.${n.toggleField.name}).toBe(!created.${n.toggleField.name});
`
    : "";
  // A protected page's mount redirects when signed out, so the session carries a
  // user; a public page is scoped to the sid alone.
  const session = spec.protectedRoute
    ? `{ sid: "test-${spec.plural}", user: { id: "test-user", email: "test@example.test" } }`
    : `{ sid: "test-${spec.plural}" }`;
  return `import { testLive } from "@rpxd/testing";
import { describe, expect, it } from "vitest";
import route from "../routes/${spec.plural}";

// Generated by \`rpxd scaffold\`. Exercises the real live object end to end.
describe("${spec.plural} route", () => {
  it("mounts empty, creates${n.toggleField ? ", toggles" : ""}, and removes a ${spec.schema}", async () => {
    const t = await testLive(route, { session: ${session} });
    expect(t.state.rows).toEqual([]);

    await t.rpc.create({ text: "first" });
    expect(t.state.rows).toHaveLength(1);
    const created = t.state.rows[0];
    if (!created) throw new Error("expected a created row");${displayAssert}
${toggleBlock}
    await t.rpc.remove({ id: created.id });
    expect(t.state.rows).toHaveLength(0);

    await t.dispose();
  });
});
`;
}

function domainTest(spec: ResourceSpec, n: Names): string {
  const input = `{ ${spec.fields.map((f) => `${f.name}: ${defaultFor(f)}`).join(", ")} }`;
  if (spec.hasDb) {
    // Prisma-backed: behavioral test needs a database, so gate it and keep a
    // smoke assertion green in a fresh checkout (TDD stub — flesh it out).
    return `import { describe, expect, it } from "vitest";
import * as ${n.domainFile} from "./${n.domainFile}";

describe("${spec.context} domain", () => {
  it("exposes the resource API", () => {
    expect(typeof ${n.domainFile}.${n.listFn}).toBe("function");
    expect(typeof ${n.domainFile}.${n.createFn}).toBe("function");
    expect(typeof ${n.domainFile}.${n.removeFn}).toBe("function");
  });

  // TODO: behavioral tests — run against a test database (\`bun run setup\`).
  it.todo("creates and lists a ${spec.schema} scoped to the owner");
});
`;
  }
  return `import { describe, expect, it } from "vitest";
import type { Scope } from "./scope";
import { ${n.createFn}, ${n.listFn}, ${n.removeFn} } from "./${n.domainFile}";

const scope: Scope = { sid: "test-session" };

describe("${spec.context} domain (in-memory)", () => {
  it("creates, lists, then removes a ${spec.schema} scoped to the owner", async () => {
    const before = await ${n.listFn}(scope);
    const row = await ${n.createFn}(scope, ${input});
    expect(row.id).toBeTruthy();

    const after = await ${n.listFn}(scope);
    expect(after).toHaveLength(before.length + 1);
    expect(after.some((r) => r.id === row.id)).toBe(true);

    await ${n.removeFn}(scope, row.id);
    expect(await ${n.listFn}(scope)).not.toContainEqual(row);
  });

  it("isolates rows by scope", async () => {
    const other: Scope = { sid: "other-session" };
    await ${n.createFn}(scope, ${input});
    expect(await ${n.listFn}(other)).toHaveLength(0);
  });
});
`;
}

/**
 * The Prisma model for a resource — appended to `prisma/schema.prisma`. A
 * `references` field emits its foreign-key column plus a `@relation` to the
 * parent (run `prisma format` to add the inverse field on the parent), and each
 * relation gets its own `@@index`.
 *
 * @example
 * ```ts
 * prismaModel({ schema: "Post", fields: [{ name: "authorId", type: "references",
 *   reference: { model: "User", relationName: "author" }, … }], … });
 * ```
 */
export function prismaModel(spec: ResourceSpec): string {
  const cols: string[] = [];
  const indexes = ["  @@index([owner])"];
  for (const f of spec.fields) {
    if (f.type === "references" && f.reference) {
      cols.push(`  ${f.name.padEnd(9)} ${f.prismaType}`);
      cols.push(
        `  ${f.reference.relationName.padEnd(9)} ${f.reference.model} @relation(fields: [${f.name}], references: [id])`,
      );
      indexes.push(`  @@index([${f.name}])`);
    } else {
      const def = f.type === "boolean" ? " @default(false)" : "";
      cols.push(`  ${f.name.padEnd(9)} ${f.prismaType}${def}`);
    }
  }
  return `model ${spec.schema} {
  id      String   @id @default(cuid())
  owner   String
${cols.join("\n")}
  created DateTime @default(now())

${indexes.join("\n")}
}`;
}

/**
 * Build the resource files. The domain module is Prisma-backed when
 * `spec.hasDb`, otherwise in-memory; the test matches.
 *
 * @example
 * ```ts
 * resourceFiles({ context: "Todos", schema: "Todo", plural: "todos",
 *   fields: [], hasDb: false, hasAuth: false, protectedRoute: false });
 * ```
 */
export function resourceFiles(spec: ResourceSpec): FileWrite[] {
  const n = namesOf(spec);
  const domain = spec.hasDb ? prismaDomain(spec, n) : memoryDomain(spec, n);
  // A page gets a testLive route test (e2e); an http route, which has no rpcs,
  // gets a domain test.
  const testFile =
    spec.kind === "http"
      ? { path: `domain/${n.domainFile}.test.ts`, contents: domainTest(spec, n) }
      : { path: `test/${spec.plural}.test.ts`, contents: routeTest(spec, n) };
  const routeFile =
    spec.kind === "http"
      ? { path: `routes/${spec.plural}.ts`, contents: httpRoute(spec, n) }
      : { path: `routes/${spec.plural}.tsx`, contents: pageRoute(spec, n) };
  return [routeFile, { path: `domain/${n.domainFile}.ts`, contents: domain }, testFile];
}

export { httpRoute, namesOf, pageRoute };
