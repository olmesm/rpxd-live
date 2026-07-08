/**
 * Casing + (naive) inflection helpers for the scaffold generator. Deliberately
 * simple — English-ish `s`/`es`/`y→ies` rules cover the identifiers a scaffold
 * produces; irregular nouns can be passed explicitly (`scaffold People Person people`).
 */

/** Split an identifier on separators and camelCase humps into lowercase words. */
function words(input: string): string[] {
  return input
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase());
}

/**
 * `todo_items` → `TodoItems`.
 *
 * @example
 * ```ts
 * pascalCase("todo_items"); // "TodoItems"
 * ```
 */
export function pascalCase(input: string): string {
  return words(input)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join("");
}

/**
 * `TodoItems` → `todoItems`.
 *
 * @example
 * ```ts
 * camelCase("TodoItems"); // "todoItems"
 * ```
 */
export function camelCase(input: string): string {
  const p = pascalCase(input);
  return p.charAt(0).toLowerCase() + p.slice(1);
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
  return words(input).join("-");
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
