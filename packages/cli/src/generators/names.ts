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
