/**
 * `<LiveSlot>` (§13, ADR 0002 items 9–10): a prop-addressed live object embedded
 * in plain React. Where a page is addressed by the URL, a slot is addressed by
 * `of` (the imported live object) plus `params` (its identity) — the pattern-
 * filled string is the instance key. It mounts over the app-lifetime connection,
 * renders the same render props a page gets, and survives navigation when it
 * lives in a persistent region (a layout, item 13).
 *
 * Identity vs props (Decision 1): a `params` change *remounts* (release + mount);
 * a `props` change is a tier-1 `patchProps` (re-guard + re-load, state
 * preserved). Prop writes are diff-coalesced per microtask so a burst of same-tick
 * changes sends at most one patch with the final value.
 */
import {
  canonicalProps,
  isRedirect,
  type LiveRoute,
  type PathParams,
  type RenderProps,
} from "@rpxd/core";
import {
  createElement,
  type FunctionComponent,
  type ReactElement,
  type ReactNode,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import type { SlotHandle } from "./connection.ts";
import { useLiveStore } from "./react.ts";
import { ConnectionContext, fillPattern, useNav } from "./router.tsx";
import { rpcMetaFromDef } from "./store.ts";

/** Remounts within {@link FLAP_WINDOW_MS} above this count trip the dev flap warning. */
const FLAP_THRESHOLD = 5;
/** Sliding window for flap detection. */
const FLAP_WINDOW_MS = 1000;

/** True in any non-production build — bundlers dead-code-eliminate the dev-only branches. */
const isDevBuild = (): boolean =>
  typeof process === "undefined" || process.env.NODE_ENV !== "production";

/**
 * Props for {@link LiveSlot}. `Path`/`Props` are inferred from `of` — the same
 * `LiveRoute` shape a page has (Decision 2: any live object is slottable), so
 * `params` is exactly the pattern's `PathParams` and `props` is the declared
 * props type.
 */
export interface LiveSlotProps<S, Path extends string, Session, Component, Props> {
  /** The live object to embed — the module's default export. */
  of: LiveRoute<S, Path, Session, Component, Props>;
  /**
   * Identity: fills the pattern's `$param` segments. A change remounts the slot
   * (Decision 1). Required even when the pattern has no params (pass `{}`).
   */
  params: PathParams<Path>;
  /** Patchable view-state record — a change reruns `guard`+`load`, state preserved. */
  props?: Props;
  /** Rendered until the first snapshot arrives, and on deny / mount failure. */
  fallback?: ReactNode;
  /** Called when a mount or runtime `guard`/`load` deny redirects — the slot stays `fallback`. */
  onDeny?: (location: string) => void;
}

/** Params whose value changed between two identity records (dev flap diagnostic). */
function changedParams(
  prev: Record<string, string> | undefined,
  next: Record<string, string>,
): string {
  if (!prev) return Object.keys(next).join(", ");
  const keys = new Set([...Object.keys(prev), ...Object.keys(next)]);
  const changed = [...keys].filter((k) => prev[k] !== next[k]);
  return changed.join(", ");
}

/**
 * Inner view: subscribes to the mounted slot's store and renders the live
 * object's component once confirmed state exists. Split out so the `useLiveStore`
 * hook has a stable store for its whole lifetime (the outer component only
 * mounts this once a handle resolves).
 */
function SlotView<S, Session>(props: {
  handle: SlotHandle<S, Session>;
  // biome-ignore lint/suspicious/noExplicitAny: the slot hosts a component of any rpc shape
  component: FunctionComponent<RenderProps<S, Session, any>>;
  fallback: ReactNode;
}): ReactElement {
  const { handle, component, fallback } = props;
  const snap = useLiveStore(handle.store);
  // Slots don't OWN the URL, but a layout slot (an agent chat panel, ADR
  // Decision 5) legitimately drives app navigation — so it gets the real `nav`.
  const nav = useNav();
  // Mirror navigation.ts's `stateReady`: render `fallback` until the first full
  // envelope confirms (§2) — a slot never SSRs, it client-mounts post-hydration.
  if (handle.store.confirmed === undefined) return <>{fallback}</>;
  return createElement(component, {
    state: snap.state,
    session: (snap.session ?? {}) as Session,
    sync: snap.sync,
    status: snap.status,
    keyOf: snap.keyOf,
    rpc: handle.store.rpc,
    nav,
  }) as ReactElement;
}

/**
 * Embed a live object as a slot (ADR 0002 item 10). Mounts on an effect keyed by
 * `[connection, identity]`; a `params` change releases the old instance and
 * mounts the new one (ordered); unmount releases. `props` changes coalesce into
 * one `patchProps` per microtask. A mount deny throws a redirect from
 * `mountSlot`, caught here to call `onDeny` and keep `fallback`; a later runtime
 * deny fires the handle's `onDeny` sink, tearing the slot back down to `fallback`.
 *
 * StrictMode-safe: the double-invoked mount effect settles on exactly one live
 * instance (the superseded mount releases itself via the `live` flag). In dev,
 * more than {@link FLAP_THRESHOLD} identity changes within a second logs once,
 * naming the unstable param — a value that changes should be in `props`, not the
 * pattern.
 *
 * @example
 * ```tsx
 * import Chat from "../chat.tsx";
 * <LiveSlot of={Chat} params={{ room: "main" }} props={{ tools }} fallback={<Spinner />} />;
 * ```
 */
export function LiveSlot<S, Path extends string, Session, Component, Props>(
  props: LiveSlotProps<S, Path, Session, Component, Props>,
): ReactElement {
  const { of, params, fallback = null, onDeny } = props;
  const slotProps = (props.props ?? {}) as Record<string, unknown>;
  const connection = useContext(ConnectionContext);
  const id = fillPattern(of.path, params as Record<string, string>);

  const [handle, setHandle] = useState<SlotHandle<S, Session> | null>(null);
  const [denied, setDenied] = useState(false);

  // Live mirrors read by the async mount + the microtask differ.
  const latestProps = useRef(slotProps);
  latestProps.current = slotProps;
  const onDenyRef = useRef(onDeny);
  onDenyRef.current = onDeny;
  const metaRef = useRef<ReturnType<typeof rpcMetaFromDef>>({});
  // `of.def`'s Props type param is invariant vs the erased `any` the meta
  // extractor takes; the cast is safe — `rpcMetaFromDef` only reads `.rpc`.
  metaRef.current = rpcMetaFromDef(of.def as Parameters<typeof rpcMetaFromDef>[0]);

  const handleRef = useRef<SlotHandle<S, Session> | null>(null);
  // Canonical form of the props the server currently knows (mount-time, then
  // each patch) — the dedup baseline so an unchanged record never re-patches.
  const lastSentCanon = useRef<string | undefined>(undefined);

  // Flap detection (dev only): remount timestamps + a once-per-instance latch.
  const remountTimes = useRef<number[]>([]);
  const flapFired = useRef(false);
  const prevId = useRef<string | undefined>(undefined);
  const prevParams = useRef<Record<string, string> | undefined>(undefined);

  /** Patch the slot iff its props changed since the server last heard (dedup). */
  const sendIfChanged = (h: SlotHandle<S, Session>): void => {
    const canon = canonicalProps(latestProps.current);
    if (canon === lastSentCanon.current) return;
    lastSentCanon.current = canon;
    h.patchProps(latestProps.current);
  };

  // Mount effect — keyed on identity (ADR: `[conn, id]`). `meta` is read from a
  // ref so a meta change never re-keys the mount; only identity remounts.
  // biome-ignore lint/correctness/useExhaustiveDependencies: identity-keyed by design; meta/props flow via refs
  useEffect(() => {
    // Flap check runs only on a real identity change (StrictMode's same-id
    // re-invoke must not inflate the count).
    if (isDevBuild() && id !== prevId.current) {
      const now = Date.now();
      const times = remountTimes.current;
      times.push(now);
      while (times.length > 0 && now - (times[0] as number) > FLAP_WINDOW_MS) times.shift();
      if (times.length > FLAP_THRESHOLD && !flapFired.current) {
        flapFired.current = true;
        const which = changedParams(prevParams.current, params as Record<string, string>);
        console.error(
          `[rpxd] <LiveSlot of="${of.path}"> is remounting rapidly (${times.length}× in ${FLAP_WINDOW_MS}ms) — ` +
            `unstable identity param(s): ${which}. Identity params remount; put values that change in \`props\`, not the pattern.`,
        );
      }
    }
    prevId.current = id;
    prevParams.current = params as Record<string, string>;

    let live = true;
    const mountProps = latestProps.current;
    setDenied(false);
    if (!connection) return;

    connection.mountSlot<S, Session>(id, mountProps, { meta: metaRef.current }).then(
      (h) => {
        // Superseded (identity changed / unmounted) before we resolved: this
        // stale mount releases itself so nothing lingers subscribed.
        if (!live) {
          h.release();
          return;
        }
        handleRef.current = h;
        lastSentCanon.current = canonicalProps(mountProps);
        h.onDeny((loc) => {
          if (!live) return;
          h.release();
          handleRef.current = null;
          setHandle(null);
          setDenied(true);
          onDenyRef.current?.(loc);
        });
        setHandle(h);
        // A props change during the in-flight mount: flush it now (dedup skips a
        // no-op). Live diffs after this go through the microtask effect below.
        sendIfChanged(h);
      },
      (e) => {
        if (!live) return;
        // A mount deny is a thrown redirect (item 9) — keep `fallback`, notify.
        // Any other mount failure also degrades to `fallback`.
        setDenied(true);
        if (isRedirect(e)) onDenyRef.current?.(e.location);
      },
    );

    return () => {
      live = false;
      handleRef.current?.release();
      handleRef.current = null;
      lastSentCanon.current = undefined;
      setHandle(null);
    };
  }, [connection, id]);

  // Prop-diff effect — runs after every commit, coalescing same-tick prop
  // changes into ONE microtask that sends the final value (dedup guards no-ops
  // and the pre-mount window, where the mount's own flush covers the first send).
  const scheduled = useRef(false);
  useEffect(() => {
    if (scheduled.current) return;
    scheduled.current = true;
    queueMicrotask(() => {
      scheduled.current = false;
      const h = handleRef.current;
      if (h) sendIfChanged(h);
    });
  });

  if (denied || !handle) return <>{fallback}</>;
  return (
    <SlotView
      handle={handle}
      component={of.component as FunctionComponent<RenderProps<S, Session, unknown>>}
      fallback={fallback}
    />
  );
}
