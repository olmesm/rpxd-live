/**
 * The `rpxd dev`/`rpxd start` startup banner: a dense block-glyph RPXD
 * wordmark that rolls in from the right (ease-out, speed-line trail, one-frame
 * overshoot), then the server summary beneath it, then logs as normal.
 *
 * Frame generation is pure ({@link wordmark}, {@link rollOffsets},
 * {@link renderRollFrame}, {@link infoLines}); {@link startBanner} is the thin
 * impure player that does the ANSI cursor work. The animation runs
 * concurrently with server boot — {@link BannerHandle.finish} joins both.
 *
 * Escape hatch (deliberately an easter egg): `BORING=me` prints the plain
 * one-liner instead. Any `BORING` value works, but only `me` earns the
 * deadpan acknowledgment. CI / non-TTY / narrow terminals fall back to the
 * same plain output automatically, no incantation required.
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

// 5-row block font, each letter 6 columns on the base grid. Letter glyphs use
// only █▀▄ so the roll's ░▒▓ trail (and its coloring) can't collide with them.
const LETTERS: Record<string, readonly string[]> = {
  R: ["█████▄", "██  ██", "█████▀", "██ ▀█▄", "██  ██"],
  P: ["█████▄", "██  ██", "█████▀", "██    ", "██    "],
  X: ["██  ██", " ▀██▀ ", "  ██  ", " ▄██▄ ", "██  ██"],
  D: ["█████▄", "██  ██", "██  ██", "██  ██", "█████▀"],
};
const ROWS = 5;
const GAP = "  ";
const BASE_MARK = Array.from({ length: ROWS }, (_, row) =>
  ["R", "P", "X", "D"].map((l) => (LETTERS[l] as readonly string[])[row] as string).join(GAP),
);
const HIDE_CURSOR = "\x1b[?25l";
const SHOW_CURSOR = "\x1b[?25h";
// Gradient endpoints: magenta → orange across the wordmark.
const GRAD_FROM = [217, 70, 239] as const;
const GRAD_TO = [251, 146, 60] as const;

/**
 * The RPXD wordmark, horizontally stretched `scale`× (each base column
 * repeated) — that stretch is what makes it dense rather than a skinny figlet.
 *
 * @example
 * ```ts
 * wordmark(4); // 5 rows, 120 columns wide
 * ```
 */
export function wordmark(scale = 1): string[] {
  if (scale <= 1) return [...BASE_MARK];
  return BASE_MARK.map((row) => row.replace(/./g, (c) => c.repeat(scale)));
}

/**
 * Pick the horizontal stretch for a terminal width: ~150 columns of glyph on
 * ultrawide, ~120 on wide, ~90 on standard; `0` means "too narrow to animate"
 * (the caller falls back to plain output).
 *
 * @example
 * ```ts
 * pickScale(160); // 5 → a 150-column wordmark
 * ```
 */
export function pickScale(columns: number): number {
  if (columns >= 155) return 5;
  if (columns >= 125) return 4;
  if (columns >= 95) return 3;
  return 0;
}

/**
 * The roll-in's x-offset per frame: ease-out from just inside the right edge
 * (`width`) toward the left margin, ending with a one-frame overshoot past 0
 * and a snap back — the "thunk" that sells the roll.
 *
 * @example
 * ```ts
 * rollOffsets(120, 30); // [101, 84, ..., 3, 1, -2, 0]
 * ```
 */
export function rollOffsets(width: number, markWidth: number, frames = 18): number[] {
  const easeOutCubic = (t: number): number => 1 - (1 - t) ** 3;
  const glide: number[] = [];
  for (let i = 1; i <= frames; i++) {
    glide.push(Math.round(width * (1 - easeOutCubic(i / frames))));
  }
  while (glide.length > 0 && glide[glide.length - 1] === 0) glide.pop();
  const overshoot = Math.max(2, Math.round(markWidth / 15));
  return [...glide, -overshoot, 0];
}

/** `▓▓▒▒░░` speed lines, dense nearest the mark, `len` characters total. */
function trailGlyphs(len: number): string {
  if (len <= 0) return "";
  const dense = Math.ceil(len * 0.4);
  const mid = Math.ceil((len - dense) / 2);
  return "▓".repeat(dense) + "▒".repeat(mid) + "░".repeat(len - dense - mid);
}

/**
 * One animation frame: the wordmark at `offset` (negative = overshooting past
 * the left margin), a `trailLen`-column fading trail behind it, everything
 * clipped to `width`.
 *
 * @example
 * ```ts
 * renderRollFrame(wordmark(3), 40, 120, 8);
 * ```
 */
export function renderRollFrame(
  mark: string[],
  offset: number,
  width: number,
  trailLen: number,
): string[] {
  const trail = trailGlyphs(trailLen);
  return mark.map((row) => {
    let line = " ".repeat(Math.max(0, offset)) + row + trail;
    if (offset < 0) line = line.slice(-offset);
    return line.slice(0, Math.max(0, width)).trimEnd();
  });
}

/**
 * The server summary that pops beneath the locked wordmark, framed between
 * rule lines of the banner's width.
 *
 * @example
 * ```ts
 * infoLines({ command: "dev", port: 3000, transport: "sse", rsc: false, routes: 3 }, 90, false);
 * ```
 */
export function infoLines(info: BannerInfo, width: number, color: boolean): string[] {
  const dim = (s: string): string => (color ? `\x1b[2m${s}\x1b[22m` : s);
  const cyan = (s: string): string => (color ? `\x1b[36m${s}\x1b[39m` : s);
  const rule = dim("─".repeat(width));
  const head = [`rpxd ${info.command}`];
  if (info.version) head.push(`v${info.version}`);
  if (info.readyMs !== undefined) head.push(`ready in ${Math.round(info.readyMs)} ms`);
  const lines = [rule, `  ${head.join(" · ")}`, `  ➜ local    ${cyan(localUrl(info.port))}`];
  if (info.networkUrl) lines.push(`  ➜ network  ${cyan(info.networkUrl)}`);
  lines.push(`  ${summarySegments(info).join(" · ")}`, rule);
  return lines;
}

/**
 * The no-theatrics output: CI, non-TTY, narrow terminals — and the documented
 * `BORING=me` easter egg, which gets a deadpan `(fine.)`. Any other `BORING`
 * value still disables the banner (an escape hatch that sometimes fails is a
 * bug), just without the acknowledgment.
 *
 * @example
 * ```ts
 * plainLines(info, { BORING: "me" });
 * // ["rpxd dev → http://localhost:3000  (fine.)", "  transport sse · ..."]
 * ```
 */
export function plainLines(info: BannerInfo, env: Record<string, string | undefined>): string[] {
  const fine = env.BORING === "me" ? "  (fine.)" : "";
  const segments = summarySegments(info);
  if (info.readyMs !== undefined) segments.push(`ready in ${Math.round(info.readyMs)} ms`);
  return [`rpxd ${info.command} → ${localUrl(info.port)}${fine}`, `  ${segments.join(" · ")}`];
}

/**
 * Decide the output tier: `"full"` (wordmark, and animation for `dev`) only
 * in a wide interactive terminal with no opt-out in play; `"plain"` otherwise.
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
  if (pickScale(stream.columns ?? 0) === 0) return "plain";
  return "full";
}

/**
 * Paint one frame row: letter glyphs (`█▀▄`) get the magenta→orange gradient
 * positioned relative to the mark's `offset`, trail glyphs (`░▒▓`) go dim
 * gray, everything else passes through. Identity when `enabled` is false.
 *
 * @example
 * ```ts
 * colorizeRow("  ██▓░", 2, 30, true);
 * ```
 */
export function colorizeRow(
  row: string,
  offset: number,
  markWidth: number,
  enabled: boolean,
): string {
  if (!enabled) return row;
  let out = "";
  let open = false;
  for (let i = 0; i < row.length; i++) {
    const ch = row[i] as string;
    if (ch === "█" || ch === "▀" || ch === "▄") {
      const t = Math.min(1, Math.max(0, (i - offset) / markWidth));
      const [r, g, b] = GRAD_FROM.map((from, c) =>
        Math.round(from + ((GRAD_TO[c] as number) - from) * t),
      );
      out += `\x1b[38;2;${r};${g};${b}m${ch}`;
      open = true;
    } else if (ch === "░" || ch === "▒" || ch === "▓") {
      out += `\x1b[38;5;240m${ch}`;
      open = true;
    } else {
      if (open) {
        out += "\x1b[0m";
        open = false;
      }
      out += ch;
    }
  }
  return open ? `${out}\x1b[0m` : out;
}

/** A minimal writable surface — `process.stdout`, or a capture in tests. */
export interface BannerStream {
  write(chunk: string): unknown;
  isTTY?: boolean;
  columns?: number;
}

/** Options for {@link startBanner}; everything impure is injectable. */
export interface StartBannerOptions {
  /** `dev` animates the roll-in; `start` prints the locked frame statically. */
  command: "dev" | "start";
  /** Output stream. Default `process.stdout`. */
  stream?: BannerStream;
  /** Environment for the opt-out checks. Default `process.env`. */
  env?: Record<string, string | undefined>;
  /** Frame delay. Default real `setTimeout`; tests inject an instant one. */
  sleep?: (ms: number) => Promise<void>;
  /** Console to buffer while frames rewrite lines. Default the global. */
  consoleObj?: Console;
  /** Roll-in frame count. Default 18 (~600 ms at 30 fps). */
  frames?: number;
}

/** A banner in flight: join it with the boot result, or bail out. */
export interface BannerHandle {
  /** Wait for the roll to land, then print the server summary. */
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
 * Kick off the startup banner. In a wide TTY, `dev` starts the roll-in
 * immediately so it plays *while* the server boots (the animation covers the
 * wait instead of adding to it); `start` holds the static frame. Everywhere
 * else — CI, pipes, narrow terminals, `BORING=me` — plain lines.
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
  let aborted = false;
  let restoreConsole: (() => void) | undefined;

  // Ctrl-C mid-roll must not leave the user's terminal without a cursor.
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
      const mark = wordmark(pickScale(stream.columns ?? 0));
      const markWidth = (mark[0] as string).length;
      const width = Math.max(markWidth, (stream.columns ?? markWidth + 1) - 1);
      stream.write(HIDE_CURSOR);
      let first = true;
      let prev = width;
      for (const offset of rollOffsets(width, markWidth, opts.frames)) {
        if (aborted) break;
        // The wake fills the gap the mark leaves toward the right edge (its
        // right edge is off-screen early in the roll), sized by frame speed
        // so it dies out naturally as the mark brakes.
        const gap = Math.max(0, width - (offset + markWidth));
        const trailLen = offset <= 0 ? 0 : Math.min(gap, 3 * Math.max(0, prev - offset));
        prev = offset;
        const rows = renderRollFrame(mark, offset, width, trailLen);
        const painted = rows.map((row) => `\x1b[2K${colorizeRow(row, offset, markWidth, color)}`);
        stream.write(`${first ? "" : `\x1b[${mark.length}A`}${painted.join("\n")}\n`);
        first = false;
        await sleep(1000 / 30);
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
        const mark = wordmark(pickScale(stream.columns ?? 0));
        const markWidth = (mark[0] as string).length;
        if (!animate) {
          const locked = mark.map((row) => colorizeRow(row, 0, markWidth, color));
          stream.write(`${locked.join("\n")}\n`);
        }
        const networkUrl = info.networkUrl ?? detectNetworkUrl(info.port);
        stream.write(`${infoLines({ ...info, networkUrl }, markWidth, color).join("\n")}\n`);
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
