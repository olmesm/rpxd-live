/**
 * `rpxd scaffold <Context> <Schema> <plural> [field:type…]` — a Phoenix-style
 * resource generator. Emits a route, a scoped domain module, and a test;
 * auth-aware (user-scoped, and pages are protected by default when the app has
 * auth — `--no-protected` opts out) and db-aware
 * (Prisma-backed vs. in-memory). For a db app the Prisma model is *appended* to
 * `prisma/schema.prisma` (append-only, never rewrites your models); everything
 * else that touches a hand-owned file is printed (docs/routes-and-auth.md).
 */
import type { ProjectFeatures } from "./detect.ts";
import { parseFields } from "./fields.ts";
import { assertIdentifier, pascalCase, routePlural } from "./names.ts";
import { prismaModel, type ResourceSpec, resourceFiles } from "./templates/resource.ts";
import type { GeneratorPlan } from "./types.ts";

/** Inputs for {@link planScaffold}. */
export interface ScaffoldOptions {
  /** Context (Phoenix module), e.g. `Todos`. */
  context: string;
  /** Schema singular, e.g. `Todo`. */
  schema: string;
  /** Plural — the route path + table, e.g. `todos`. */
  plural: string;
  /** `name:type` schema tokens. */
  fieldSpecs: string[];
  /** `page` (live route, default) or `http` (`route()` endpoint). */
  kind?: "page" | "http";
  /**
   * Protect the page behind the mount gate. Defaults to the app's auth status
   * (protected when auth is present); set explicitly to override.
   */
  protectedRoute?: boolean;
  /** Emit the domain test. Default true. */
  test?: boolean;
  /** Detected app features (drives db/auth-aware output). */
  features: ProjectFeatures;
}

/**
 * Build the resource file plan.
 *
 * @example
 * ```ts
 * planScaffold({ context: "Todos", schema: "Todo", plural: "todos",
 *   fieldSpecs: ["text:string", "done:boolean"],
 *   features: { hasDb: true, hasAuth: true } });
 * ```
 */
export function planScaffold(options: ScaffoldOptions): GeneratorPlan {
  const kind = options.kind ?? "page";
  const fields = parseFields(options.fieldSpecs);
  const steps: string[] = [];

  // Secure by default: an auth app protects pages unless you opt out
  // (`--no-protected`). Without auth there's no login route to bounce to, and
  // an http route has no mount gate — so protection only applies to authed pages.
  const explicit = options.protectedRoute;
  let protectedRoute = explicit ?? options.features.hasAuth;
  if (kind === "http") {
    if (explicit === true) steps.push("Ignored --protected: only live pages have a mount gate.");
    protectedRoute = false;
  } else if (protectedRoute && !options.features.hasAuth) {
    if (explicit === true) {
      steps.push("Ignored --protected: this app has no auth. Run `rpxd auth` first.");
    }
    protectedRoute = false;
  }
  if (protectedRoute && explicit === undefined) {
    steps.push(
      "Protected by default (auth detected): mount redirects to /login when signed out. Pass --no-protected for a public page.",
    );
  }

  const spec: ResourceSpec = {
    context: assertIdentifier(pascalCase(options.context), "context"),
    schema: assertIdentifier(pascalCase(options.schema), "schema"),
    plural: assertIdentifier(routePlural(options.plural), "plural"),
    fields,
    hasDb: options.features.hasDb,
    hasAuth: options.features.hasAuth,
    protectedRoute,
    kind,
  };

  let files = resourceFiles(spec);
  if (options.test === false) files = files.filter((f) => !f.path.endsWith(".test.ts"));

  const appends: GeneratorPlan["appends"] = [];
  const commands: string[] = [];
  if (spec.hasDb) {
    // Append the model to schema.prisma (append-only, idempotent via the marker).
    appends.push({
      path: "prisma/schema.prisma",
      marker: `model ${spec.schema} `,
      content: prismaModel(spec),
    });
    const hasRelation = fields.some((f) => f.type === "references");
    if (hasRelation) {
      steps.push(
        "Run `prisma format` — it inserts the inverse relation field on the parent model(s).",
      );
      steps.push(
        "Decide scoping for this resource: it's scoped by `owner` (the acting user/session) — adjust the domain queries if it should be reached through its parent instead.",
      );
    }
    commands.push("bunx prisma format", "bun run db:push");
  }

  return { files, appends, steps, commands };
}
