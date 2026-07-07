/**
 * React bindings for {@link LiveStore} — a thin `useSyncExternalStore` layer.
 * The live component itself stays plain React fed via props (§1).
 */
import { useSyncExternalStore } from "react";
import type { LiveStore, StoreSnapshot } from "./store.ts";

/**
 * Subscribe a component to a live store. Returns the current snapshot:
 * `{ state, session, sync, status, keyOf }` — referentially stable between
 * store changes so memoized children skip re-renders off the patch path (§2).
 *
 * @example
 * ```tsx
 * function Board({ store }: { store: LiveStore<BoardState> }) {
 *   const { state, sync, keyOf } = useLiveStore(store);
 *   return <ul>{state.todos.map((t) => <li key={keyOf(t.id)}>{t.text}</li>)}</ul>;
 * }
 * ```
 */
export function useLiveStore<S, Session>(store: LiveStore<S, Session>): StoreSnapshot<S, Session> {
  return useSyncExternalStore(store.subscribe, store.snapshot, store.snapshot);
}
