/**
 * Minimal, self-contained session auth — a stand-in for a real auth library
 * (Better Auth, Lucia, …) at the SAME seam (docs/routes-and-auth.md). It owns
 * the `/api/auth/*` subtree (`auth.handler`) and resolves a request → user
 * (`auth.getSession`). Swap this file for a real library and nothing in
 * `routes/` or `rpxd.config.ts` changes shape — the seam is identical.
 *
 * In-memory + an opaque session cookie; resets on restart. Web-crypto hashing
 * keeps it dependency-free and Bun/Node-portable. This demonstrates the wiring,
 * not production hardening — reach for the real library for that.
 */

/** The public identity carried in the {@link Scope}. */
export interface User {
  id: string;
  email: string;
}

interface UserRecord {
  id: string;
  email: string;
  salt: string;
  hash: string;
}

const SESSION_COOKIE = "todos_session";

// `authenticate` (rpxd.config) and the `/api/auth/*` route import this file in
// different module graphs (CLI context vs Vite SSR graph), so a plain
// module-level Map would be two separate stores — sign-in writes one,
// `authenticate` reads the other. A globalThis singleton shares one store
// across graphs, exactly as a real DB would back a real auth library.
interface AuthStore {
  users: Map<string, UserRecord>; // email → record
  sessions: Map<string, string>; // token → userId
}
const globals = globalThis as typeof globalThis & { __todosAuth?: AuthStore };
globals.__todosAuth ??= { users: new Map(), sessions: new Map() };
const { users, sessions } = globals.__todosAuth;

async function hashPassword(salt: string, password: string): Promise<string> {
  const data = new TextEncoder().encode(`${salt}:${password}`);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function readCookie(req: Request, name: string): string | undefined {
  const found = (req.headers.get("cookie") ?? "")
    .split(";")
    .map((c) => c.trim())
    .find((c) => c.startsWith(`${name}=`));
  return found?.slice(name.length + 1);
}

function setCookie(token: string, maxAge?: number): string {
  const age = maxAge === undefined ? "" : `; Max-Age=${maxAge}`;
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax${age}`;
}

function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { "content-type": "application/json", ...init.headers },
  });
}

function userOf(req: Request): User | null {
  const token = readCookie(req, SESSION_COOKIE);
  const userId = token ? sessions.get(token) : undefined;
  if (!userId) return null;
  const rec = [...users.values()].find((u) => u.id === userId);
  return rec ? { id: rec.id, email: rec.email } : null;
}

function startSession(rec: UserRecord): Response {
  const token = crypto.randomUUID();
  sessions.set(token, rec.id);
  return json(
    { user: { id: rec.id, email: rec.email } },
    { headers: { "set-cookie": setCookie(token) } },
  );
}

/** Own the `/api/auth/*` subtree — sign-up / sign-in / sign-out / session. */
async function handler(req: Request): Promise<Response> {
  const action = new URL(req.url).pathname.replace(/^\/api\/auth\/?/, "");

  if (req.method === "POST" && action === "sign-up") {
    const { email, password } = (await req.json()) as { email?: string; password?: string };
    if (!email || !password) return json({ error: "email and password required" }, { status: 400 });
    if (users.has(email)) return json({ error: "already registered" }, { status: 409 });
    const salt = crypto.randomUUID();
    const rec: UserRecord = {
      id: crypto.randomUUID(),
      email,
      salt,
      hash: await hashPassword(salt, password),
    };
    users.set(email, rec);
    return startSession(rec);
  }

  if (req.method === "POST" && action === "sign-in") {
    const { email, password } = (await req.json()) as { email?: string; password?: string };
    const rec = email ? users.get(email) : undefined;
    if (!rec || !password || rec.hash !== (await hashPassword(rec.salt, password))) {
      return json({ error: "invalid credentials" }, { status: 401 });
    }
    return startSession(rec);
  }

  if (req.method === "POST" && action === "sign-out") {
    const token = readCookie(req, SESSION_COOKIE);
    if (token) sessions.delete(token);
    return json({ user: null }, { headers: { "set-cookie": setCookie("", 0) } });
  }

  if (req.method === "GET" && action === "session") {
    return json({ user: userOf(req) });
  }

  return json({ error: "not found" }, { status: 404 });
}

export const auth = {
  /** Delegated behind `route("/api/auth/$").all(...)`. */
  handler,
  /** Resolve the request → session for `rpxd.config` `authenticate`. */
  getSession(req: Request): { user: User } | null {
    const user = userOf(req);
    return user ? { user } : null;
  },
};
