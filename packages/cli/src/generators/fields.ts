/**
 * Phoenix-style `field:type` parsing for `rpxd scaffold`. A schema is a list of
 * `name:type` tokens (`title:string done:boolean`); a bare `name` defaults to
 * `string`. Each token resolves to the TS type used in the generated route +
 * domain module and the Prisma type used in the printed model.
 */

/** The field types the scaffold generator understands. */
export type FieldType = "string" | "text" | "boolean" | "int" | "float" | "datetime";

/** A parsed schema field: its name plus its TS and Prisma representations. */
export interface Field {
  /** Field name (as written; camelCase by convention). */
  name: string;
  /** Normalized type token. */
  type: FieldType;
  /** TypeScript type used in row/input interfaces. */
  tsType: string;
  /** Prisma scalar type used in the printed schema model. */
  prismaType: string;
}

const TYPES: Record<FieldType, { tsType: string; prismaType: string }> = {
  string: { tsType: "string", prismaType: "String" },
  text: { tsType: "string", prismaType: "String" },
  boolean: { tsType: "boolean", prismaType: "Boolean" },
  int: { tsType: "number", prismaType: "Int" },
  float: { tsType: "number", prismaType: "Float" },
  datetime: { tsType: "Date", prismaType: "DateTime" },
};

/**
 * Parse `name:type` schema tokens into {@link Field}s.
 *
 * @throws if a token uses a type outside {@link FieldType}.
 *
 * @example
 * ```ts
 * parseFields(["title:string", "done:boolean"]);
 * // [{ name: "title", type: "string", tsType: "string", prismaType: "String" }, …]
 * ```
 */
export function parseFields(specs: string[]): Field[] {
  return specs.map((spec) => {
    const [rawName = "", rawType = "string"] = spec.split(":");
    const name = rawName.trim();
    if (!name) throw new Error(`empty field name in "${spec}"`);
    const type = rawType as FieldType;
    const mapping = TYPES[type];
    if (!mapping) {
      throw new Error(
        `unknown field type "${rawType}" for "${name}" — use one of ${Object.keys(TYPES).join(", ")}`,
      );
    }
    return { name, type, ...mapping };
  });
}
