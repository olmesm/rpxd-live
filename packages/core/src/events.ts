/**
 * Framework event sink (#73): the one typed, app-pluggable seam every part of
 * the runtime reports through — rejections, denials, dropped messages, and
 * recovered errors. Generalizes the security-events hook (#84): security is
 * now just one `category`. An app installs a single sink (server-bun's
 * `onEvent`) to log/meter/forward the whole stream; with none installed the
 * runtime falls back to {@link defaultEventSink}, so console behavior is
 * unchanged out of the box.
 */

/**
 * A structured event the rpxd runtime emitted — a security rejection, a failed
 * request, a recovered instance error, or a storage fault (#73). Namespaced by
 * `category`; `type` is stable and descriptive within it (e.g. `load-failed`).
 * The app decides how to surface it — the runtime never blocks on the sink and
 * swallows any throw from it ({@link makeEmit}).
 *
 * @example
 * ```ts
 * const sink: RpxdEventSink = (e: RpxdEvent) => {
 *   if (e.level === "error") metrics.increment(`rpxd.${e.category}.${e.type}`);
 * };
 * ```
 */
export interface RpxdEvent {
  /** Top-level bucket the event belongs to. */
  category: "security" | "request" | "instance" | "storage";
  /** Stable, descriptive event name, namespaced within `category` (e.g. `load-failed`). */
  type: string;
  /** Severity — maps to `console.error`/`warn`/`info`/`debug` in {@link defaultEventSink}. */
  level: "debug" | "info" | "warn" | "error";
  /** Structured context (topic, sid, path, rpc name, …). Never contains secrets. */
  detail?: Record<string, unknown>;
  /** The throwable, when the event describes a caught error. */
  error?: unknown;
}

/**
 * App-supplied event sink (#73): receives every {@link RpxdEvent} the runtime
 * emits. Install one via server-bun's `onEvent`. It must not throw — the
 * runtime wraps it ({@link makeEmit}) so observability can never break a
 * request — and should return promptly (offload slow I/O).
 *
 * @example
 * ```ts
 * createRpxdHandler({ routes, onEvent: (e) => logger.log(e.level, e) });
 * ```
 */
export type RpxdEventSink = (event: RpxdEvent) => void;

/**
 * The out-of-the-box sink: switch on `level` to the matching `console` method,
 * formatting `"[rpxd] {category}/{type}"` followed by `detail` and/or `error`
 * when present. Reproduces the runtime's historical console output, so behavior
 * is unchanged when no app sink is installed.
 *
 * @example
 * ```ts
 * defaultEventSink({ category: "instance", type: "load-failed", level: "error", error });
 * // console.error("[rpxd] instance/load-failed", error)
 * ```
 */
export function defaultEventSink(event: RpxdEvent): void {
  const label = `[rpxd] ${event.category}/${event.type}`;
  const extra: unknown[] = [];
  if (event.detail !== undefined) extra.push(event.detail);
  if (event.error !== undefined) extra.push(event.error);
  switch (event.level) {
    case "error":
      console.error(label, ...extra);
      break;
    case "warn":
      console.warn(label, ...extra);
      break;
    case "info":
      console.info(label, ...extra);
      break;
    case "debug":
      console.debug(label, ...extra);
      break;
  }
}

/**
 * Wrap a sink so a throw from it is caught and `console.error`'d rather than
 * propagating into the request/flush path — observability must never break the
 * work it observes (#73). Defaults to {@link defaultEventSink} when no sink is
 * passed, so standalone code (core, a storage adapter) still reports to console.
 *
 * @example
 * ```ts
 * const emit = makeEmit(opts.onEvent); // falls back to console when undefined
 * emit({ category: "request", type: "request-failed", level: "error", error });
 * ```
 */
export function makeEmit(sink: RpxdEventSink = defaultEventSink): RpxdEventSink {
  return (event) => {
    try {
      sink(event);
    } catch (e) {
      console.error("[rpxd] event sink threw:", e);
    }
  };
}
