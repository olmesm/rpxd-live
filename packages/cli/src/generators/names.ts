/**
 * Casing helpers for the scaffold generator. Casing is delegated to es-toolkit
 * (well-tested Unicode-aware word splitting). There is deliberately no
 * inflection: the `<plural>` argument is always explicit, and guessing would
 * break irregular nouns (`scaffold People Person people` must stay `people`).
 */
import { camelCase as esCamelCase, kebabCase as esKebabCase, upperFirst } from "es-toolkit";

/**
 * `todo_items` → `TodoItems`.
 *
 * @example
 * ```ts
 * pascalCase("todo_items"); // "TodoItems"
 * ```
 */
export function pascalCase(input: string): string {
  return upperFirst(esCamelCase(input));
}

/**
 * `TodoItems` / `todo_items` → `todoItems`.
 *
 * @example
 * ```ts
 * camelCase("author_id"); // "authorId"
 * ```
 */
export function camelCase(input: string): string {
  return esCamelCase(input);
}

/**
 * `TodoItems` → `todo-items`.
 *
 * @example
 * ```ts
 * kebabCase("TodoItems"); // "todo-items"
 * ```
 */
export function kebabCase(input: string): string {
  return esKebabCase(input);
}

/** Columns every generated model already has — a user field can't reuse them. */
const GENERATED_COLUMNS = new Set(["id", "owner", "created"]);

/**
 * Assert `name` is a usable TS/Prisma identifier (letters/digits, starting with
 * a letter). Casing already strips punctuation; this catches what survives —
 * empty, leading-digit, symbol-only.
 *
 * @throws if `name` isn't a valid identifier.
 *
 * @example
 * ```ts
 * assertIdentifier("Todo", "schema"); // "Todo"
 * ```
 */
export function assertIdentifier(name: string, label: string): string {
  if (!/^[A-Za-z][A-Za-z0-9]*$/.test(name)) {
    throw new Error(
      `${label} "${name}" is not a valid identifier — use letters and digits, starting with a letter`,
    );
  }
  return name;
}

/**
 * Assert a field name is a valid identifier that doesn't collide with a
 * generated column (`id`, `owner`, `created`).
 *
 * @throws if the name is invalid or reserved.
 *
 * @example
 * ```ts
 * assertFieldName("title"); // "title"
 * ```
 */
export function assertFieldName(name: string): string {
  assertIdentifier(name, "field");
  if (GENERATED_COLUMNS.has(name)) {
    throw new Error(
      `field "${name}" collides with a generated column (id, owner, created) — rename it`,
    );
  }
  return name;
}

/**
 * Normalize the route/table plural segment: casing-cleaned, nothing more. The
 * argument is the user's explicitly supplied plural, so it is never
 * re-inflected — naive rules would turn irregular plurals into `peoples` /
 * `childrens` across every sink (file name, route literal, identifiers).
 *
 * @example
 * ```ts
 * routePlural("Todos");      // "todos"
 * routePlural("blog posts"); // "blogPosts"
 * routePlural("people");     // "people" — verbatim, never "peoples"
 * ```
 */
export function routePlural(input: string): string {
  return camelCase(input);
}
