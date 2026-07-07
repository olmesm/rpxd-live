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
 * Thrown when an rpc payload fails its `input` schema.
 *
 * @example
 * ```ts
 * try {
 *   await validateInput(schema, payload, "add");
 * } catch (e) {
 *   if (e instanceof ValidationError) console.log(e.issues);
 * }
 * ```
 */
export class ValidationError extends Error {
  override name = "ValidationError";
  constructor(
    public readonly issues: ReadonlyArray<{ readonly message: string }>,
    rpc: string,
  ) {
    super(`Invalid payload for rpc "${rpc}": ${issues.map((i) => i.message).join("; ")}`);
  }
}

/**
 * Validate `value` against a Standard Schema, throwing {@link ValidationError} on failure.
 *
 * @example
 * ```ts
 * const payload = await validateInput(z.object({ text: z.string() }), raw, "add");
 * ```
 */
export async function validateInput<S extends StandardSchemaV1>(
  schema: S,
  value: unknown,
  rpc: string,
): Promise<InferOutput<S>> {
  const result = await schema["~standard"].validate(value);
  if (result.issues) throw new ValidationError(result.issues, rpc);
  return result.value as InferOutput<S>;
}
