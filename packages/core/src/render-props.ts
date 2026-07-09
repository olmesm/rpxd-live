/**
 * Render props (§1): the exact shape `.render()` hands the live component —
 * `{ state, session, rpc, sync, nav, keyOf }` plus connection `status`.
 * Defined in core so the fluent builder can type components without
 * annotations; `@rpxd/client` re-exports these types and provides the
 * runtime.
 */
import type { PathParams } from "./live.ts";
import type { RegisteredPath } from "./register.ts";

/** Flatten an intersection for readable hovers. */
export type Pretty<T> = { [K in keyof T]: T[K] } & {};

/** Connection status surfaced to the UI (§11). */
export type ConnectionStatus = "connecting" | "live" | "reconnecting" | "error";

/** The `sync` render prop (§1): in-flight rpcs + surfaced errors. */
export interface SyncState {
  pending: boolean;
  inFlight: number;
  errors: { name: string; message: string; rpc?: string }[];
}

/**
 * The typed rpc facade (§5): exact keys from the route's `.rpc()` chain,
 * exact payloads from each `.input()`/reducer. Calls batch per tick and
 * settle on ack (§6).
 */
export type RpcFacade<R> = Pretty<{
  [K in keyof R]: unknown extends R[K]
    ? (payload?: unknown) => Promise<void>
    : (payload: R[K]) => Promise<void>;
}>;

/**
 * Navigation (§7): path params are identity (navigate = remount); search
 * params are view state (`patch` → `params` reducer, no remount). `navigate`
 * autocompletes registered routes via the generated `Register` merge — the
 * same typing `Link`/`useNav` get in `@rpxd/client`.
 */
export interface NavProp {
  navigate<P extends RegisteredPath>(
    to: P,
    opts?: { params?: PathParams<P>; search?: Record<string, string> },
  ): void;
  patch(search: Record<string, string>): void;
}

/**
 * Props passed to the component bound via `.render()` (§1).
 *
 * Inferred automatically inside the fluent chain; use explicitly only when
 * extracting a component to its own declaration.
 *
 * @example
 * ```tsx
 * live("/")
 *   .setup(() => ({ todos: [] as Todo[] }))
 *   .rpc("add", (r) => r.input(schema).handler(async (s, p) => { s.todos.push(p); }))
 *   .render(({ state, rpc, keyOf }) => (
 *     <ul>{state.todos.map((t) => <li key={keyOf(t.id)}>{t.text}</li>)}</ul>
 *   ));
 * ```
 */
export interface RenderProps<S, Session = Record<string, unknown>, R = Record<string, unknown>> {
  /** Optimistic view: `replay(pending, confirmed)` (§4). */
  state: S;
  /** Session slice (view state — filters etc., §7). */
  session: Session;
  /** Typed rpc facade (§5, §6). */
  rpc: RpcFacade<R>;
  /** In-flight + error surface (§1). */
  sync: SyncState;
  /** Connection status (§11). */
  status: ConnectionStatus;
  /** Stable keys across tempId→realId transitions (§4). */
  keyOf: (id: string | number) => string;
  /** navigate (remount) + patch (search params, no remount) (§7). */
  nav: NavProp;
}
