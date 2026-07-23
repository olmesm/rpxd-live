/**
 * Minimal Standard Schema v1 interface (https://standardschema.dev).
 * Lets `input:` accept Zod / Valibot / ArkType without depending on any of
 * them.
 */
export interface StandardSchemaV1<Input = unknown, Output = Input> {
  readonly "~standard": {
    readonly version: 1;
    readonly vendor: string;
    readonly validate: (
      value: unknown,
    ) => StandardSchemaResult<Output> | Promise<StandardSchemaResult<Output>>;
    readonly types?: { readonly input: Input; readonly output: Output } | undefined;
  };
}

/** Result union produced by a Standard Schema `validate` call. */
export type StandardSchemaResult<Output> =
  | { readonly value: Output; readonly issues?: undefined }
  | { readonly issues: ReadonlyArray<{ readonly message: string }> };

/** Infer the validated output type of a Standard Schema. */
export type InferOutput<S> = S extends StandardSchemaV1<unknown, infer O> ? O : never;

/**
 * Thrown when a validated input fails its Standard Schema. Used for both rpc
 * payloads and route props, so the message is driven by a caller-supplied
 * `label` (e.g. `rpc "add"` or `props /report/$id`) rather than assuming rpc.
 *
 * @example
 * ```ts
 * try {
 *   await validateInput(schema, payload, 'rpc "add"');
 * } catch (e) {
 *   if (e instanceof ValidationError) console.log(e.issues);
 * }
 * ```
 */
export class ValidationError extends Error {
  override name = "ValidationError";
  // Plain field (not a parameter property) so the source stays erasable —
  // Node runs it under default, unflagged TypeScript stripping.
  readonly issues: ReadonlyArray<{ readonly message: string }>;
  constructor(issues: ReadonlyArray<{ readonly message: string }>, label: string) {
    super(`Invalid input for ${label}: ${issues.map((i) => i.message).join("; ")}`);
    this.issues = issues;
  }
}

/**
 * Validate `value` against a Standard Schema, throwing {@link ValidationError} on
 * failure. `label` names what is being validated (an rpc, a route's props) and
 * flows into the error message — callers pass a self-describing label so the
 * wording stays honest for non-rpc inputs.
 *
 * @example
 * ```ts
 * const payload = await validateInput(z.object({ text: z.string() }), raw, 'rpc "add"');
 * ```
 */
export async function validateInput<S extends StandardSchemaV1>(
  schema: S,
  value: unknown,
  label: string,
): Promise<InferOutput<S>> {
  const result = await schema["~standard"].validate(value);
  if (result.issues) throw new ValidationError(result.issues, label);
  return result.value as InferOutput<S>;
}
