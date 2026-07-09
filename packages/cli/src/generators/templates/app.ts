/**
 * Templates for the app shell `rpxd init` scaffolds: the framework document
 * (`__root`/`__404`/`__error`), the zero-config `rpxd.config.ts`, a runnable
 * welcome route, the `Scope` primitive, and the project manifests. Kept close
 * to `examples/kitchen-sink` so drift between the demo and generated apps is visible.
 */
import type { FileWrite } from "../types.ts";

/** Shape shared by the app-shell builders. */
export interface AppOptions {
  /** Package name for the generated `package.json`. */
  name: string;
  /** Wire Prisma/SQLite (`adapters/db.ts`, `prisma/`). */
  db: boolean;
  /** Wire Better Auth (implies {@link AppOptions.db}). */
  auth: boolean;
}

const packageJson = ({ name, db, auth }: AppOptions): string => {
  const deps: Record<string, string> = {
    "@rpxd/client": "^0.1.0",
    "@rpxd/core": "^0.1.0",
    "@rpxd/rsc": "^0.1.0",
    react: "^19.0.0",
    "react-dom": "^19.0.0",
  };
  if (db) {
    deps["@libsql/client"] = "^0.17.4";
    deps["@prisma/adapter-libsql"] = "^7.8.0";
    deps["@prisma/client"] = "^7.8.0";
  }
  if (auth) deps["better-auth"] = "^1.6.23";

  const devDeps: Record<string, string> = {
    "@rpxd/cli": "^0.1.0",
    "@rpxd/testing": "^0.1.0",
    "@rpxd/vite-plugin": "^0.1.0",
    "@types/bun": "^1.3.14",
    "@types/node": "^26.0.0",
    "@types/react": "^19.0.0",
    "@types/react-dom": "^19.0.0",
    typescript: "^5.9.0",
    vitest: "^4.1.10",
  };
  if (db) devDeps.prisma = "^7.8.0";

  const scripts: Record<string, string> = {
    dev: "rpxd dev",
    build: "rpxd build",
    start: "rpxd start",
    test: "vitest run",
    typecheck: "tsc --noEmit",
  };
  if (db) {
    scripts.setup = "prisma generate && prisma db push";
    scripts["db:generate"] = "prisma generate";
    scripts["db:push"] = "prisma db push";
  }

  const sorted = (o: Record<string, string>) =>
    Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)));

  return `${JSON.stringify(
    {
      name,
      private: true,
      type: "module",
      scripts,
      dependencies: sorted(deps),
      devDependencies: sorted(devDeps),
    },
    null,
    2,
  )}\n`;
};

const tsconfig = (db: boolean): string =>
  `${JSON.stringify(
    {
      compilerOptions: {
        target: "ES2022",
        module: "ESNext",
        moduleResolution: "bundler",
        lib: ["ES2022", "DOM", "DOM.Iterable"],
        jsx: "react-jsx",
        strict: true,
        noUncheckedIndexedAccess: true,
        verbatimModuleSyntax: true,
        isolatedModules: true,
        skipLibCheck: true,
        forceConsistentCasingInFileNames: true,
        resolveJsonModule: true,
        allowImportingTsExtensions: true,
        noEmit: true,
        types: ["bun", "node"],
      },
      include: [
        "routes/**/*",
        "domain/**/*",
        ...(db ? ["adapters/**/*"] : []),
        "rpxd.config.ts",
        ".rpxd/**/*",
      ],
      // Tests are typechecked + run by Vitest, not the app's build tsc.
      exclude: ["node_modules", "dist", "**/*.test.ts"],
    },
    null,
    2,
  )}\n`;

const gitignore = (): string => `node_modules/
dist/
*.tsbuildinfo
.vite/
.rpxd/
*.db
*.db-*
generated/
`;

const viteEnv = (): string => `/// <reference types="vite/client" />\n`;

const vitestConfig = (): string => `import { defineConfig } from "vitest/config";

// Runs the tests \`rpxd scaffold\` generates — testLive route tests exercise the
// real live object (mount, rpcs, patches); domain tests cover the service layer.
export default defineConfig({
  test: { include: ["**/*.test.{ts,tsx}"], exclude: ["**/node_modules/**", "dist/**"] },
});
`;

const rpxdConfig = (auth: boolean): string =>
  auth
    ? `import { defineConfig } from "@rpxd/cli";
import { auth } from "./adapters/auth.ts";

/**
 * App config (§14). \`session.authenticate\` runs once per request and its
 * return becomes \`ctx.session\` everywhere; project the auth library's session
 * down to a STABLE \`{ id, email }\` so a rolling token doesn't thrash the warm
 * instance (the routes & auth guide).
 */
export default defineConfig({
  session: {
    authenticate: async (req, { sid }) => {
      const s = await auth.api.getSession({ headers: req.headers });
      return { sid, user: s?.user ? { id: s.user.id, email: s.user.email } : undefined };
    },
  },
});
`
    : `import { defineConfig } from "@rpxd/cli";

/** App config (§14). memory() storage + sse() transport are the defaults. */
export default defineConfig({});
`;

const root = (auth: boolean): string => `import { Link } from "@rpxd/client";
import type { ReactNode } from "react";

/**
 * HTML shell + providers (§14): static, no live state. Wraps every page.
 * \`Link\` navigation is soft (§7) — routes swap without a full page load.
 */
export default function Root({ children }: { children: ReactNode }) {
  return (
    <div data-shell="app-root">
      <nav>
        <Link to="/">home</Link>${auth ? ' · <Link to="/account">account</Link>' : ""}
      </nav>
      {children}
    </div>
  );
}
`;

const notFound = (): string => `/** Unmatched URL page (§14). Static — receives the missed path. */
export default function NotFound({ path }: { path: string }) {
  return (
    <main data-testid="not-found">
      <h1>Nothing at {path}</h1>
      <a href="/">Home</a>
    </main>
  );
}
`;

const errorPage = (): string => `/** Mount rejection / handler crash page (§10, §14). Static. */
export default function ErrorPage({ path, message }: { path: string; message: string }) {
  return (
    <main data-testid="error-page">
      <h1>Something broke at {path}</h1>
      <pre>{message}</pre>
    </main>
  );
}
`;

const welcomeRoute = (): string => `import { live } from "@rpxd/core";

/**
 * Welcome page — a self-contained live object (no data layer) so a fresh app
 * runs immediately. The counter demonstrates the wire: an optimistic bump
 * shows instantly, the handler's \`patchState\` confirms it. Replace this with
 * \`rpxd scaffold\`-generated resources as your app grows.
 */
export default live("/")
  .setup(() => ({ count: 0 }))
  .rpc("increment", (r) =>
    r
      .optimistic((state) => {
        state.count += 1;
      })
      .handler(async (_payload, ctx) => {
        ctx.patchState((s) => {
          s.count += 1;
        });
      }),
  )
  .render(({ state, rpc, sync }) => (
    <main>
      <h1>rpxd</h1>
      <p data-testid="count">count: {state.count}</p>
      <button type="button" data-testid="increment" onClick={() => void rpc.increment()}>
        +1
      </button>
      {sync.pending && <span data-testid="pending">syncing…</span>}
    </main>
  ));
`;

const scope = (): string => `/**
 * Scope — who is acting (the routes & auth guide). Free of any \`db\`/Prisma
 * import so the render component (client) can call \`scopeFrom(session)\` without
 * dragging the data layer into the client bundle. The domain layer scopes by it.
 */

/** The authenticated user, when signed in. */
export interface ScopeUser {
  id: string;
  email: string;
}

/**
 * Who is acting: the framework session id plus the authenticated user, if any.
 * An anonymous visitor is scoped to their \`sid\`; a signed-in user to \`user.id\`.
 */
export interface Scope {
  sid: string;
  user?: ScopeUser;
}

/** Derive a {@link Scope} from the untyped \`ctx.session\` bag. */
export function scopeFrom(session: unknown): Scope {
  const s = (session ?? {}) as { sid?: unknown; user?: ScopeUser };
  return { sid: typeof s.sid === "string" ? s.sid : "anonymous", user: s.user };
}
`;

/**
 * The always-present app-shell files (independent of db/auth).
 *
 * @example
 * ```ts
 * appShellFiles({ name: "my-app", db: false, auth: false });
 * ```
 */
export function appShellFiles(opts: AppOptions): FileWrite[] {
  return [
    { path: "package.json", contents: packageJson(opts) },
    { path: "tsconfig.json", contents: tsconfig(opts.db) },
    { path: ".gitignore", contents: gitignore() },
    { path: "vite-env.d.ts", contents: viteEnv() },
    { path: "vitest.config.ts", contents: vitestConfig() },
    { path: "rpxd.config.ts", contents: rpxdConfig(opts.auth) },
    { path: "routes/__root.tsx", contents: root(opts.auth) },
    { path: "routes/__404.tsx", contents: notFound() },
    { path: "routes/__error.tsx", contents: errorPage() },
    { path: "routes/index.tsx", contents: welcomeRoute() },
    { path: "domain/scope.ts", contents: scope() },
  ];
}
