/**
 * Framework diagnostic sink (#73): the one typed, app-pluggable seam every part
 * of the runtime reports through — rejections, denials, dropped messages, and
 * recovered errors. Generalizes the security-events hook (#84): security is
 * now just one `category`. An app installs a single sink (server-bun's
 * `onDiagnostic`) to log/meter/forward the whole stream; with none installed the
 * runtime falls back to {@link defaultDiagnosticSink}, so console behavior is
 * unchanged out of the box.
 */

/**
 * A structured diagnostic the rpxd runtime emitted — a security rejection, a
 * failed request, a recovered instance error, or a storage fault (#73).
 * Namespaced by `category`; `type` is stable and descriptive within it (e.g.
 * `load-failed`). The app decides how to surface it — the runtime never blocks
 * on the sink and swallows any throw from it ({@link makeDiagnosticEmit}).
 *
 * @example
 * ```ts
 * const sink: RpxdDiagnosticSink = (d: RpxdDiagnostic) => {
 *   if (d.level === "error") metrics.increment(`rpxd.${d.category}.${d.type}`);
 * };
 * ```
 */
export interface RpxdDiagnostic {
  /** Top-level bucket the diagnostic belongs to. */
  category: "security" | "request" | "instance" | "storage";
  /** Stable, descriptive diagnostic name, namespaced within `category` (e.g. `load-failed`). */
  type: string;
  /** Severity — maps to `console.error`/`warn`/`info`/`debug` in {@link defaultDiagnosticSink}. */
  level: "debug" | "info" | "warn" | "error";
  /** Structured context (topic, sid, path, rpc name, …). Never contains secrets. */
  detail?: Record<string, unknown>;
  /** The throwable, when the diagnostic describes a caught error. */
  error?: unknown;
}

/**
 * App-supplied diagnostic sink (#73): receives every {@link RpxdDiagnostic} the
 * runtime emits. Install one via server-bun's `onDiagnostic`. It must not throw
 * — the runtime wraps it ({@link makeDiagnosticEmit}) so observability can never
 * break a request — and should return promptly (offload slow I/O).
 *
 * @example
 * ```ts
 * createRpxdHandler({ routes, onDiagnostic: (d) => logger.log(d.level, d) });
 * ```
 */
export type RpxdDiagnosticSink = (diagnostic: RpxdDiagnostic) => void;

/**
 * The out-of-the-box sink: switch on `level` to the matching `console` method,
 * formatting `"[rpxd] {category}/{type}"` followed by `detail` and/or `error`
 * when present. Reproduces the runtime's historical console output, so behavior
 * is unchanged when no app sink is installed.
 *
 * @example
 * ```ts
 * defaultDiagnosticSink({ category: "instance", type: "load-failed", level: "error", error });
 * // console.error("[rpxd] instance/load-failed", error)
 * ```
 */
export function defaultDiagnosticSink(diagnostic: RpxdDiagnostic): void {
  const label = `[rpxd] ${diagnostic.category}/${diagnostic.type}`;
  const extra: unknown[] = [];
  if (diagnostic.detail !== undefined) extra.push(diagnostic.detail);
  if (diagnostic.error !== undefined) extra.push(diagnostic.error);
  switch (diagnostic.level) {
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
 * work it observes (#73). Defaults to {@link defaultDiagnosticSink} when no sink
 * is passed, so standalone code (core, a storage adapter) still reports to
 * console.
 *
 * @example
 * ```ts
 * const emit = makeDiagnosticEmit(opts.onDiagnostic); // falls back to console when undefined
 * emit({ category: "request", type: "request-failed", level: "error", error });
 * ```
 */
export function makeDiagnosticEmit(
  sink: RpxdDiagnosticSink = defaultDiagnosticSink,
): RpxdDiagnosticSink {
  return (diagnostic) => {
    try {
      sink(diagnostic);
    } catch (e) {
      console.error("[rpxd] diagnostic sink threw:", e);
    }
  };
}
