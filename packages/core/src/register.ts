/**
 * Registered-route typing (§7): derived from the {@link Register} merge
 * target, which lives in `index.ts` — module augmentation only merges with
 * interfaces declared (not re-exported) in the augmented module.
 */
import type { Register } from "./index.ts";

type Routes = Register extends { routes: infer R } ? R : Record<string, never>;

/** All registered route paths — falls back to `string` before codegen runs. */
export type RegisteredPath = [keyof Routes] extends [never] ? string : keyof Routes & string;
