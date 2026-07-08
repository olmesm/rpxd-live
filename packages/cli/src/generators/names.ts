/**
 * Casing + (naive) inflection helpers for the scaffold generator. Casing is
 * delegated to es-toolkit (well-tested Unicode-aware word splitting); the
 * English-ish `s`/`es`/`y→ies` inflection is naive on purpose — irregular
 * nouns can be passed explicitly (`scaffold People Person people`).
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

/**
 * Naive pluralization (`box`→`boxes`, `city`→`cities`, `note`→`notes`).
 *
 * @example
 * ```ts
 * pluralize("note"); // "notes"
 * ```
 */
export function pluralize(input: string): string {
  if (/[^aeiou]y$/.test(input)) return `${input.slice(0, -1)}ies`;
  if (/(s|x|z|ch|sh)$/.test(input)) return `${input}es`;
  return `${input}s`;
}

/**
 * Naive singularization (inverse of {@link pluralize}).
 *
 * @example
 * ```ts
 * singularize("todos"); // "todo"
 * ```
 */
export function singularize(input: string): string {
  if (/ies$/.test(input)) return `${input.slice(0, -3)}y`;
  if (/(ses|xes|zes|ches|shes)$/.test(input)) return input.slice(0, -2);
  if (/s$/.test(input)) return input.slice(0, -1);
  return input;
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
 * Normalize a route/table plural segment: casing-cleaned and guaranteed plural,
 * idempotent whether the argument arrives singular or already plural (so it
 * never double-pluralizes). Chains {@link camelCase} → {@link singularize} →
 * {@link pluralize}.
 *
 * @example
 * ```ts
 * routePlural("Todos");      // "todos"
 * routePlural("todo");       // "todos"
 * routePlural("blog posts"); // "blogPosts"
 * ```
 */
export function routePlural(input: string): string {
  return pluralize(singularize(camelCase(input)));
}
