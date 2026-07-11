/**
 * The `rpxd dev`/`rpxd start` startup banner: `rpxd dev` types out in the
 * brand gradient (magenta → orange), a shine sweeps across the rule beneath
 * it while the title's color drains away — both ending on the same frame —
 * then the server summary prints and logs follow.
 *
 * Frame generation is pure ({@link titleFrame}, {@link ruleFrame},
 * {@link infoLines}); {@link startBanner} is the thin impure player that does
 * the ANSI cursor work. The animation runs concurrently with server boot —
 * {@link BannerHandle.finish} joins both.
 *
 * Escape hatch: any `BORING` value prints the plain lines instead (the
 * documented incantation is `BORING=me`; an escape hatch that sometimes fails
 * is a bug, so every value works). CI / non-TTY / narrow terminals fall back
 * to the same plain output automatically, no incantation required.
 */
import { networkInterfaces } from "node:os";

/** What the banner knows about the server it announces. */
export interface BannerInfo {
  /** Which CLI command booted the server. */
  command: "dev" | "start";
  /** The bound port (the real one — after an ephemeral bind resolves). */
  port: number;
  /** Resolved transport kind (§11). */
  transport: "sse" | "ws";
  /** Whether RSC fields are on (§16). */
  rsc: boolean;
  /** Registered route count (live pages + `route()` handlers). */
  routes: number;
  /** CLI package version, when known. */
  version?: string;
  /** Boot duration in milliseconds, when measured. */
  readyMs?: number;
  /**
   * LAN URL to advertise next to localhost. `undefined` → auto-detect from
   * the first non-internal IPv4 interface; `""` → show none.
   */
  networkUrl?: string;
}

/** Banner rule width; also the minimum comfortable animation width. */
const WIDTH = 40;
/** Gradient endpoints: magenta → orange across the typed title. */
const GRAD_FROM = [217, 70, 239] as const;
const GRAD_TO = [251, 146, 60] as const;
/** Fade target ≈ a typical terminal foreground; the settle frame goes plain. */
const INKISH = [222, 213, 201] as const;
/** Length of the gradient shine head on the rule. */
const SHINE = 8;

const HIDE_CURSOR = "\x1b[?25l";
const SHOW_CURSOR = "\x1b[?25h";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

const mix = (a: readonly number[], b: readonly number[], t: number): number[] =>
  a.map((v, i) => Math.round(v + ((b[i] as number) - v) * t));

const fg = (c: readonly number[]): string => `\x1b[38;2;${c[0]};${c[1]};${c[2]}m`;

/**
 * One frame of the typed title: the first `chars` characters of `title`,
 * bold, colored across the brand gradient and mixed toward plain by `fade`
 * (0 = full gradient, 1 = no color at all). Identity-plain when `color` is
 * false.
 *
 * @example
 * ```ts
 * titleFrame("rpxd dev", 4, 0, true); // "rpx d" typed so far, full gradient
 * ```
 */
export function titleFrame(title: string, chars: number, fade: number, color: boolean): string {
  const shown = title.slice(0, chars);
  if (!color || fade >= 1) return `\x1b[1m${shown}${RESET}`;
  let out = "\x1b[1m";
  for (let i = 0; i < shown.length; i++) {
    const base = mix(GRAD_FROM, GRAD_TO, i / Math.max(1, title.length - 1));
    out += `${fg(mix(base, INKISH, fade))}${shown[i]}`;
  }
  return `${out}${RESET}`;
}

/**
 * One frame of the rule: drawn out to column `head`, with the last
 * {@link SHINE} columns carrying the gradient shine. At `head === width`
 * with `color` false (or after the settle frame) it is the plain dim rule.
 *
 * @example
 * ```ts
 * ruleFrame(40, 20, true); // half-drawn rule with a gradient head
 * ```
 */
export function ruleFrame(width: number, head: number, color: boolean): string {
  const end = Math.min(width, head);
  if (!color) return `${DIM}${"─".repeat(end)}${RESET}`;
  const tail = Math.max(0, end - SHINE);
  let out = `${DIM}${"─".repeat(tail)}${RESET}`;
  for (let x = tail; x < end; x++) {
    out += `${fg(mix(GRAD_FROM, GRAD_TO, (x - tail) / SHINE))}─`;
  }
  return `${out}${RESET}`;
}

/**
 * The summary under the rule — four content rows and the closing rule. No
 * `rpxd dev` header: the typed title above already says it.
 *
 * @example
 * ```ts
 * infoLines({ command: "dev", port: 3000, transport: "sse", rsc: false, routes: 3 }, 40, false);
 * ```
 */
export function infoLines(info: BannerInfo, width: number, color: boolean): string[] {
  const dim = (s: string): string => (color ? `${DIM}${s}\x1b[22m` : s);
  const cyan = (s: string): string => (color ? `\x1b[36m${s}\x1b[39m` : s);
  const head: string[] = [];
  if (info.version) head.push(`v${info.version}`);
  if (info.readyMs !== undefined) head.push(`ready in ${Math.round(info.readyMs)} ms`);
  const lines: string[] = [];
  if (head.length > 0) lines.push(`  ${head.join(" · ")}`);
  lines.push(`  ➜ local    ${cyan(localUrl(info.port))}`);
  if (info.networkUrl) lines.push(`  ➜ network  ${cyan(info.networkUrl)}`);
  lines.push(`  ${summarySegments(info).join(" · ")}`, dim("─".repeat(width)));
  return lines;
}

/**
 * The no-theatrics output: CI, non-TTY, narrow terminals, and any `BORING`
 * value (the documented incantation is `BORING=me` — an escape hatch that
 * sometimes fails is a bug, so every value works).
 *
 * @example
 * ```ts
 * plainLines(info, { BORING: "me" });
 * // ["rpxd dev → http://localhost:3000", "  transport sse · ..."]
 * ```
 */
export function plainLines(info: BannerInfo, _env: Record<string, string | undefined>): string[] {
  const segments = summarySegments(info);
  if (info.readyMs !== undefined) segments.push(`ready in ${Math.round(info.readyMs)} ms`);
  return [`rpxd ${info.command} → ${localUrl(info.port)}`, `  ${segments.join(" · ")}`];
}

/**
 * Decide the output tier: `"full"` (typed title + rule shine, animated for
 * `dev`) only in an interactive terminal with no opt-out in play; `"plain"`
 * otherwise.
 *
 * @example
 * ```ts
 * bannerMode(process.env, process.stdout); // "full" | "plain"
 * ```
 */
export function bannerMode(
  env: Record<string, string | undefined>,
  stream: { isTTY?: boolean; columns?: number },
): "full" | "plain" {
  if (env.BORING || env.CI || env.TERM === "dumb") return "plain";
  if (!stream.isTTY) return "plain";
  if ((stream.columns ?? 0) < WIDTH + 6) return "plain";
  return "full";
}

/** A minimal writable surface — `process.stdout`, or a capture in tests. */
export interface BannerStream {
  write(chunk: string): unknown;
  isTTY?: boolean;
  columns?: number;
}

/** Options for {@link startBanner}; everything impure is injectable. */
export interface StartBannerOptions {
  /** `dev` animates; `start` prints the settled title + rule statically. */
  command: "dev" | "start";
  /** Output stream. Default `process.stdout`. */
  stream?: BannerStream;
  /** Environment for the opt-out checks. Default `process.env`. */
  env?: Record<string, string | undefined>;
  /** Frame delay. Default real `setTimeout`; tests inject an instant one. */
  sleep?: (ms: number) => Promise<void>;
  /** Console to buffer while frames rewrite lines. Default the global. */
  consoleObj?: Console;
}

/** A banner in flight: join it with the boot result, or bail out. */
export interface BannerHandle {
  /** Wait for the animation to settle, then print the server summary. */
  finish(info: Omit<BannerInfo, "command">): Promise<void>;
  /** Boot failed: stop animating, restore the cursor, print nothing more. */
  abort(): Promise<void>;
}

const CONSOLE_METHODS = ["log", "info", "warn", "error", "debug"] as const;

/**
 * Hold console output back while animation frames rewrite lines in place —
 * route modules imported during boot may log at module scope, and interleaved
 * writes would garble the frames. Returns the restore-and-flush function.
 */
function bufferConsole(consoleObj: Console): () => void {
  const buffered: Array<{ method: (typeof CONSOLE_METHODS)[number]; args: unknown[] }> = [];
  const originals = new Map<string, (...args: unknown[]) => void>();
  for (const method of CONSOLE_METHODS) {
    const original = (consoleObj as unknown as Record<string, unknown>)[method];
    if (typeof original !== "function") continue;
    originals.set(method, original as (...args: unknown[]) => void);
    (consoleObj as unknown as Record<string, unknown>)[method] = (...args: unknown[]) => {
      buffered.push({ method, args });
    };
  }
  return () => {
    for (const [method, original] of originals) {
      (consoleObj as unknown as Record<string, unknown>)[method] = original;
    }
    for (const { method, args } of buffered) originals.get(method)?.(...args);
  };
}

function localUrl(port: number): string {
  return `http://localhost:${port}`;
}

function summarySegments(info: BannerInfo): string[] {
  return [
    `transport ${info.transport}`,
    `rsc ${info.rsc ? "on" : "off"}`,
    `${info.routes} route${info.routes === 1 ? "" : "s"}`,
  ];
}

/** First non-internal IPv4 address as a URL, or `""` when there isn't one. */
function detectNetworkUrl(port: number): string {
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (!address.internal && address.family === "IPv4") {
        return `http://${address.address}:${port}`;
      }
    }
  }
  return "";
}

/**
 * Kick off the startup banner. In an interactive terminal, `dev` starts the
 * typed-title + rule-shine animation immediately so it plays *while* the
 * server boots (it covers the wait instead of adding to it); the title's
 * gradient fades out in lockstep with the shine, both ending together.
 * `start` prints the settled title statically. Everywhere else — CI, pipes,
 * narrow terminals, `BORING=me` — plain lines.
 *
 * @example
 * ```ts
 * const banner = startBanner({ command: "dev" });
 * const t0 = performance.now();
 * const server = await createDevServer(root, { port });
 * await banner.finish({ port: server.port, readyMs: performance.now() - t0, ...server.info });
 * ```
 */
export function startBanner(opts: StartBannerOptions): BannerHandle {
  const stream: BannerStream = opts.stream ?? process.stdout;
  const env = opts.env ?? process.env;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const mode = bannerMode(env, stream);
  const color = mode === "full" && env.NO_COLOR === undefined;
  const animate = mode === "full" && opts.command === "dev";
  const title = `rpxd ${opts.command}`;
  let aborted = false;
  let restoreConsole: (() => void) | undefined;

  // Ctrl-C mid-animation must not leave the user's terminal without a cursor.
  const onSigint = (): void => {
    stream.write(SHOW_CURSOR);
  };
  const unhook = (): void => {
    restoreConsole?.();
    restoreConsole = undefined;
    if (stream === process.stdout) process.removeListener("SIGINT", onSigint);
  };

  let animation: Promise<void> = Promise.resolve();
  if (animate) {
    restoreConsole = bufferConsole(opts.consoleObj ?? console);
    if (stream === process.stdout) process.once("SIGINT", onSigint);
    animation = (async () => {
      stream.write(HIDE_CURSOR);
      // the title types out in full gradient
      for (let i = 1; i <= title.length && !aborted; i++) {
        stream.write(`${i === 1 ? "" : "\x1b[1A"}\x1b[2K${titleFrame(title, i, 0, color)}\n`);
        await sleep(28);
      }
      // the shine sweeps the rule while the title color drains — ending together
      const SWEEP = 16;
      for (let f = 1; f <= SWEEP && !aborted; f++) {
        const fade = (f / SWEEP) ** 2; // hold the color, drain at the end
        stream.write(
          `${f === 1 ? "\x1b[1A" : "\x1b[2A"}\x1b[2K${titleFrame(title, title.length, fade, color)}\n` +
            `\x1b[2K${ruleFrame(WIDTH, Math.round((WIDTH * f) / SWEEP), color)}\n`,
        );
        await sleep(30);
      }
      if (!aborted) {
        // settle: plain bold title over the quiet full rule
        stream.write(
          `\x1b[2A\x1b[2K${titleFrame(title, title.length, 1, color)}\n` +
            `\x1b[2K${ruleFrame(WIDTH, WIDTH, false)}\n`,
        );
      }
      stream.write(SHOW_CURSOR);
    })();
  }

  return {
    async finish(partial) {
      await animation;
      try {
        const info: BannerInfo = { ...partial, command: opts.command };
        if (mode === "plain") {
          stream.write(`${plainLines(info, env).join("\n")}\n`);
          return;
        }
        if (!animate) {
          // start: the settled frame, no animation
          stream.write(
            `${titleFrame(title, title.length, 1, color)}\n${ruleFrame(WIDTH, WIDTH, false)}\n`,
          );
        }
        const networkUrl = info.networkUrl ?? detectNetworkUrl(info.port);
        stream.write(`${infoLines({ ...info, networkUrl }, WIDTH, color).join("\n")}\n`);
      } finally {
        // Buffered boot logs replay *below* the summary — the banner stays
        // one intact block, logs beneath it.
        unhook();
      }
    },
    async abort() {
      aborted = true;
      await animation;
      unhook();
    },
  };
}
