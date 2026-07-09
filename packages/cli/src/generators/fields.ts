/**
 * `field:type` parsing for `rpxd scaffold`. A schema is a list of
 * `name:type` tokens (`title:string done:boolean`); a bare `name` defaults to
 * `string`. Field names are normalized to camelCase (`author_id` → `authorId`)
 * so the generated TS + Prisma is idiomatic regardless of how they're typed.
 *
 * A `references` field is a foreign-key relation: `author_id:references:User` →
 * a `String` foreign key plus (in the printed Prisma model) a `@relation` to
 * `User`. See {@link Field.reference}.
 */
import { assertFieldName, assertIdentifier, camelCase } from "./names.ts";

/** The field types the scaffold generator understands. */
export type FieldType =
  | "string"
  | "text"
  | "boolean"
  | "int"
  | "float"
  | "datetime"
  | "date"
  | "json"
  | "references";

/** The parent side of a `references` (foreign-key) field. */
export interface FieldReference {
  /** Referenced model, PascalCase (e.g. `User`). */
  model: string;
  /** Relation object field name on this model (e.g. `author`). */
  relationName: string;
}

/** A parsed schema field: its name plus its TS and Prisma representations. */
export interface Field {
  /** Field name, camelCase (e.g. `authorId`). */
  name: string;
  /** Normalized type token. */
  type: FieldType;
  /** TypeScript type used in row/input interfaces. */
  tsType: string;
  /** Prisma scalar type used in the schema model. */
  prismaType: string;
  /** Present only for `references` — the foreign-key target + relation name. */
  reference?: FieldReference;
}

const SCALARS: Record<Exclude<FieldType, "references">, { tsType: string; prismaType: string }> = {
  string: { tsType: "string", prismaType: "String" },
  text: { tsType: "string", prismaType: "String" },
  boolean: { tsType: "boolean", prismaType: "Boolean" },
  int: { tsType: "number", prismaType: "Int" },
  float: { tsType: "number", prismaType: "Float" },
  datetime: { tsType: "Date", prismaType: "DateTime" },
  date: { tsType: "Date", prismaType: "DateTime" },
  json: { tsType: "unknown", prismaType: "Json" },
};

/** `author_id`/`author` + target `User` → `{ name: "authorId", reference }`. */
function parseReference(rawName: string, target: string | undefined, spec: string): Field {
  if (!target)
    throw new Error(`references field "${spec}" needs a model, e.g. author_id:references:User`);
  const base = camelCase(rawName);
  // `authorId` → fk `authorId`, relation `author`; `author` → fk `authorId`, relation `author`.
  const [fkName, relationName] =
    /Id$/.test(base) && base.length > 2 ? [base, base.slice(0, -2)] : [`${base}Id`, base];
  const model = assertIdentifier(
    camelCase(target).replace(/^./, (c) => c.toUpperCase()),
    "model",
  );
  return {
    name: assertFieldName(fkName),
    type: "references",
    tsType: "string",
    prismaType: "String",
    // The relation object field lands on the model alongside the generated
    // columns, so it must clear the same reserved-name check as any field —
    // `owner_id:references:User` would otherwise emit a second `owner`.
    reference: { model, relationName: assertFieldName(relationName) },
  };
}

/**
 * Parse `name:type` schema tokens into {@link Field}s.
 *
 * @throws if a token uses a type outside {@link FieldType}, or a `references`
 * token omits its target model.
 *
 * @example
 * ```ts
 * parseFields(["title:string", "author_id:references:User"]);
 * // [{ name: "title", type: "string", … },
 * //  { name: "authorId", type: "references", reference: { model: "User", relationName: "author" } }]
 * ```
 */
export function parseFields(specs: string[]): Field[] {
  const seen = new Set<string>();
  return specs.map((spec) => {
    const field = parseField(spec);
    // Names are compared post-normalization, so `full_name` and `fullName`
    // collide. Two same-named fields would emit duplicate TS interface members
    // (TS2300) and duplicate Prisma columns.
    if (seen.has(field.name)) {
      throw new Error(`duplicate field "${field.name}" — field names must be unique`);
    }
    seen.add(field.name);
    return field;
  });
}

function parseField(spec: string): Field {
  const [rawName = "", rawType = "string", target] = spec.split(":");
  if (!rawName.trim()) throw new Error(`empty field name in "${spec}"`);
  if (rawType === "references") return parseReference(rawName, target, spec);
  // `Object.hasOwn` — a bare object lookup would resolve `toString`,
  // `constructor`, `__proto__`, etc. to inherited members and slip past this
  // guard, spreading a prototype function into the field.
  const mapping = Object.hasOwn(SCALARS, rawType)
    ? SCALARS[rawType as Exclude<FieldType, "references">]
    : undefined;
  if (!mapping) {
    throw new Error(
      `unknown field type "${rawType}" for "${rawName}" — use one of ${Object.keys(SCALARS).join(", ")}, references`,
    );
  }
  return { name: assertFieldName(camelCase(rawName)), type: rawType as FieldType, ...mapping };
}
