/**
 * The render props a live component receives (§1):
 * `{ state, session, rpc, sync, nav, keyOf }` plus connection `status`.
 */
import type { Nav } from "./router.tsx";
import type { ConnectionStatus, SyncState } from "./store.ts";

/**
 * Props passed to the component bound via `live(path)(def)(component)`.
 *
 * @example
 * ```tsx
 * export default live("/")({ mount: async () => ({ todos: [] as Todo[] }) })(
 *   ({ state, rpc, keyOf }: RenderProps<{ todos: Todo[] }>) => (
 *     <ul>{state.todos.map((t) => <li key={keyOf(t.id)}>{t.text}</li>)}</ul>
 *   ),
 * );
 * ```
 */
export interface RenderProps<S, Session = Record<string, unknown>> {
  /** Optimistic view: `replay(pending, confirmed)` (§4). */
  state: S;
  /** Session slice (view state — filters etc., §7). */
  session: Session;
  /** Rpc facade — calls batch per tick and settle on ack (§6). */
  rpc: Record<string, (payload?: unknown) => Promise<void>>;
  /** In-flight + error surface (§1). */
  sync: SyncState;
  /** Connection status (§11). */
  status: ConnectionStatus;
  /** Stable keys across tempId→realId transitions (§4). */
  keyOf: (id: string | number) => string;
  /** navigate (remount) + patch (search params, no remount) (§7). */
  nav: Nav;
}
