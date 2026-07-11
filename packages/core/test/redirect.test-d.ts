/**
 * Type contract for {@link redirect} (§10). Its target autocompletes
 * {@link RegisteredPath} (like `Link`/`nav`) but stays open to any string —
 * a redirect target is a *final URL*, not a path pattern + params, so it must
 * still accept dynamic values, query strings, and non-page paths like `/403`.
 */
import { expectTypeOf } from "vitest";
import { redirect } from "../src/redirect.ts";
import type { RedirectTarget } from "../src/register.ts";

// The target is the RegisteredPath-aware open type, not a bare `string`.
expectTypeOf(redirect).parameter(0).toEqualTypeOf<RedirectTarget>();

// Stays open: dynamic / query / non-page targets still type-check.
redirect("/login");
redirect("/403");
redirect("/next?to=/home");
const dynamic = "/somewhere" as string;
redirect(dynamic);

// …but the target must be a string.
// @ts-expect-error — redirect target must be a string
redirect(123);
