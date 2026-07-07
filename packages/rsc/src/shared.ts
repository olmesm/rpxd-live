/** Marker shape for RSC fields (§16): an opaque serialized subtree in state. */
export interface RscField {
  /** Serialized server-rendered subtree. Opaque — never touch it in reducers. */
  $rsc: string;
}

/** True when a state value is an RSC field marker. */
export function isRscField(value: unknown): value is RscField {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { $rsc?: unknown }).$rsc === "string"
  );
}
