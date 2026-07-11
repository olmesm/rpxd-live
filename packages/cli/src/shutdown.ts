/**
 * Graceful-shutdown wiring for `rpxd start`. `SIGTERM` (the signal `docker stop`
 * / Kubernetes send) and `SIGINT` (Ctrl-C) run the app's ordered `close()` —
 * stop the listener, flush warm snapshots, run the userland `onShutdown` hook,
 * close storage — so a deploy doesn't SIGKILL warm state before it's persisted.
 *
 * A second signal force-exits (impatient operator / Docker escalating to
 * SIGKILL), and a timeout backstops a wedged `close()` so we never sit past the
 * container's grace period. `exit` is injectable so the handler is unit-testable.
 */
/** The ordered teardown steps `startApp().close()` runs (see {@link runCloseSequence}). */
export interface CloseSteps {
  /** Stop accepting new connections. */
  stop: () => void | Promise<void>;
  /** Flush every warm instance's snapshot to storage (§11). */
  dispose: () => void | Promise<void>;
  /** Userland cleanup (the app's `onShutdown` — closes its own DB, etc.). */
  onShutdown?: () => void | Promise<void>;
  /** Close the storage adapter rpxd owns. */
  closeStorage?: () => void | Promise<void>;
}

/**
 * Run graceful-shutdown steps in the one correct order: stop new work, **flush
 * snapshots** (needs storage open), run the app's `onShutdown`, then close
 * storage. Extracted so the ordering invariant is unit-testable.
 *
 * @example
 * ```ts
 * app.close = () =>
 *   runCloseSequence({
 *     stop: () => server.stop(),
 *     dispose: () => registry.disposeAll(),
 *     onShutdown: config.onShutdown,
 *     closeStorage: () => storage.close?.(),
 *   });
 * ```
 */
export async function runCloseSequence(steps: CloseSteps): Promise<void> {
  await steps.stop();
  await steps.dispose();
  await steps.onShutdown?.();
  await steps.closeStorage?.();
}

/**
 * Options for {@link installShutdownHandlers} — override the exit function,
 * the grace-period timeout, and the progress logger.
 *
 * @example
 * ```ts
 * installShutdownHandlers(app.close, {
 *   timeoutMs: 30_000, // match the container's terminationGracePeriodSeconds
 *   log: (m) => logger.info(m),
 * });
 * ```
 */
export interface ShutdownOptions {
  /** Process exit (injected in tests). Defaults to `process.exit`. */
  exit?: (code: number) => void;
  /** Force-exit if `close()` hasn't finished in this long. Default 10s. */
  timeoutMs?: number;
  /** Progress logger. Defaults to `console.error` (stderr, unbuffered). */
  log?: (message: string) => void;
}

/**
 * Register `SIGTERM`/`SIGINT` handlers that run `close()` once, then exit.
 * Returns a deregister function (used by tests; a real process just exits).
 *
 * @example
 * ```ts
 * const app = await startApp(process.cwd());
 * installShutdownHandlers(app.close);
 * ```
 */
export function installShutdownHandlers(
  close: () => Promise<void>,
  opts: ShutdownOptions = {},
): () => void {
  const exit = opts.exit ?? ((code: number) => process.exit(code));
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const log = opts.log ?? ((m: string) => console.error(m));
  let shuttingDown = false;

  const onSignal = (signal: NodeJS.Signals): void => {
    if (shuttingDown) {
      log(`[rpxd] ${signal} again — forcing exit.`);
      exit(1);
      return;
    }
    shuttingDown = true;
    log(`[rpxd] ${signal} — shutting down gracefully…`);
    const timer = setTimeout(() => {
      log(`[rpxd] shutdown exceeded ${timeoutMs}ms — forcing exit.`);
      exit(1);
    }, timeoutMs);
    void close()
      .then(() => exit(0))
      .catch((e) => {
        log(`[rpxd] shutdown failed: ${e instanceof Error ? e.message : String(e)}`);
        exit(1);
      })
      .finally(() => clearTimeout(timer));
  };

  process.on("SIGTERM", onSignal);
  process.on("SIGINT", onSignal);
  return () => {
    process.off("SIGTERM", onSignal);
    process.off("SIGINT", onSignal);
  };
}
