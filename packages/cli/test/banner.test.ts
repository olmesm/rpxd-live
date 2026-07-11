import { describe, expect, it } from "vitest";
import {
  type BannerInfo,
  bannerMode,
  infoLines,
  plainLines,
  ruleFrame,
  startBanner,
  titleFrame,
} from "../src/banner.ts";

// biome's noControlCharactersInRegex bans the literal — build the CSI matcher.
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[A-Za-z]`, "g");
const strip = (s: string): string => s.replace(ANSI, "");

const info: BannerInfo = {
  command: "dev",
  port: 3000,
  transport: "ws",
  rsc: true,
  routes: 14,
  version: "0.1.0",
  readyMs: 412,
  networkUrl: "",
};

describe("titleFrame", () => {
  it("types out the first N characters, bold", () => {
    expect(strip(titleFrame("rpxd dev", 4, 0, true))).toBe("rpxd");
    expect(strip(titleFrame("rpxd dev", 8, 0, true))).toBe("rpxd dev");
    expect(titleFrame("rpxd dev", 8, 0, true)).toContain("\x1b[1m");
  });

  it("carries the gradient at fade 0 — first and last characters differ", () => {
    const frame = titleFrame("rpxd dev", 8, 0, true);
    const codes = frame.match(/38;2;\d+;\d+;\d+/g) ?? [];
    expect(codes.length).toBe(8);
    expect(codes[0]).not.toBe(codes.at(-1));
  });

  it("is fully plain at fade 1 and when color is off", () => {
    expect(titleFrame("rpxd dev", 8, 1, true)).toBe("\x1b[1mrpxd dev\x1b[0m");
    expect(titleFrame("rpxd dev", 8, 0, false)).toBe("\x1b[1mrpxd dev\x1b[0m");
  });

  it("fades toward plain: colors at fade 0.9 differ from fade 0", () => {
    const hot = titleFrame("rpxd dev", 8, 0, true);
    const cooled = titleFrame("rpxd dev", 8, 0.9, true);
    expect(cooled).not.toBe(hot);
    expect(strip(cooled)).toBe(strip(hot)); // visible text identical
  });
});

describe("ruleFrame", () => {
  it("draws out to the head position", () => {
    expect(strip(ruleFrame(40, 20, true))).toBe("─".repeat(20));
    expect(strip(ruleFrame(40, 40, true))).toBe("─".repeat(40));
  });

  it("carries a gradient shine head when color is on, plain dim otherwise", () => {
    expect(ruleFrame(40, 20, true)).toContain("\x1b[38;2;");
    expect(ruleFrame(40, 40, false)).toBe(`\x1b[2m${"─".repeat(40)}\x1b[0m`);
  });

  it("never overshoots the width", () => {
    expect(strip(ruleFrame(40, 99, true)).length).toBe(40);
  });
});

describe("infoLines", () => {
  it("prints four content rows and the closing rule — no rpxd dev header", () => {
    const lines = infoLines({ ...info, networkUrl: "http://192.168.1.24:3000" }, 40, false);
    expect(lines).toHaveLength(5);
    const body = lines.join("\n");
    expect(body).toContain("v0.1.0 · ready in 412 ms");
    expect(body).toContain("➜ local    http://localhost:3000");
    expect(body).toContain("➜ network  http://192.168.1.24:3000");
    expect(body).toContain("transport ws · rsc on · 14 routes");
    expect(body).not.toContain("rpxd dev");
    expect(lines.at(-1)).toBe("─".repeat(40));
  });

  it("omits rows it has no data for", () => {
    const lines = infoLines({ ...info, version: undefined, readyMs: undefined }, 40, false);
    expect(lines).toHaveLength(3); // local, transport, rule — no header, no network
    expect(lines.join("\n")).not.toContain("ready in");
  });
});

describe("plainLines (boring/CI output)", () => {
  it("prints the plain line for BORING=me, no commentary", () => {
    const lines = plainLines(info, { BORING: "me" });
    expect(lines[0]).toBe("rpxd dev → http://localhost:3000");
    expect(lines.join("\n")).not.toContain("(fine.)");
  });

  it("disables identically for any other BORING value", () => {
    expect(plainLines(info, { BORING: "1" })).toEqual(plainLines(info, { BORING: "me" }));
  });

  it("carries the same summary as the fancy banner", () => {
    const body = plainLines(info, {}).join("\n");
    expect(body).toContain("transport ws");
    expect(body).toContain("rsc on");
    expect(body).toContain("14 routes");
    expect(body).toContain("ready in 412 ms");
  });
});

describe("bannerMode", () => {
  const tty = { isTTY: true, columns: 100 };

  it("goes full in an interactive terminal", () => {
    expect(bannerMode({}, tty)).toBe("full");
  });

  it.each([
    ["BORING set", { BORING: "me" }, tty],
    ["CI", { CI: "true" }, tty],
    ["dumb terminal", { TERM: "dumb" }, tty],
    ["not a TTY", {}, { isTTY: false, columns: 100 }],
    ["too narrow", {}, { isTTY: true, columns: 40 }],
  ] as const)("falls back to plain when %s", (_reason, env, stream) => {
    expect(bannerMode(env, stream)).toBe("plain");
  });
});

describe("startBanner", () => {
  const instant = (): Promise<void> => Promise.resolve();

  function fakeStream(columns = 100, isTTY = true) {
    const chunks: string[] = [];
    return {
      chunks,
      stream: { isTTY, columns, write: (s: string) => void chunks.push(s) },
    };
  }

  it("types the title, sweeps the rule, then prints the summary (dev)", async () => {
    const { chunks, stream } = fakeStream();
    const banner = startBanner({ command: "dev", stream, env: {}, sleep: instant });
    await banner.finish(info);
    const out = chunks.join("");
    expect(out).toContain("\x1b[?25l"); // cursor hidden during animation
    expect(out).toContain("\x1b[?25h"); // and restored
    expect(out).toContain("\x1b[1A"); // title retype frames
    expect(out).toContain("\x1b[2A"); // title+rule sweep frames
    const text = strip(out);
    expect(text).toContain("rpxd dev");
    expect(text).toContain("─".repeat(40)); // the settled rule
    expect(text).toContain("http://localhost:3000");
    expect(text).toContain("transport ws");
  });

  it("ends the title fade and the shine on the same frame", async () => {
    const { chunks, stream } = fakeStream();
    const banner = startBanner({ command: "dev", stream, env: {}, sleep: instant });
    await banner.finish(info);
    // the settle frame is the last two-line rewrite: plain title + full rule
    const settle = chunks.filter((c) => c.startsWith("\x1b[2A")).at(-1) as string;
    expect(settle).toContain("\x1b[1mrpxd dev\x1b[0m"); // no gradient left
    expect(strip(settle)).toContain("─".repeat(40)); // rule fully drawn
  });

  it("buffers console output during the animation and flushes it afterwards", async () => {
    const { stream } = fakeStream();
    const logged: unknown[][] = [];
    const fakeConsole = { log: (...args: unknown[]) => void logged.push(args) };
    let noised = false;
    const banner = startBanner({
      command: "dev",
      stream,
      env: {},
      sleep: async () => {
        // Mid-animation: a route module logs at import time (once).
        if (!noised) {
          noised = true;
          fakeConsole.log("boot noise");
        }
      },
      consoleObj: fakeConsole as unknown as Console,
    });
    expect(logged).toEqual([]); // held back while frames rewrite lines
    await banner.finish(info);
    expect(logged).toEqual([["boot noise"]]); // replayed once the banner settled
    fakeConsole.log("after");
    expect(logged.at(-1)).toEqual(["after"]); // console restored
  });

  it("flushes buffered logs after the info block, not between title and summary", async () => {
    const order: string[] = [];
    const stream = {
      isTTY: true,
      columns: 100,
      write: (s: string) => void (strip(s).includes("localhost") && order.push("info")),
    };
    const fakeConsole = { log: (..._args: unknown[]) => void order.push("flushed") };
    let noised = false;
    const banner = startBanner({
      command: "dev",
      stream,
      env: {},
      sleep: async () => {
        if (!noised) {
          noised = true;
          fakeConsole.log("boot noise");
        }
      },
      consoleObj: fakeConsole as unknown as Console,
    });
    await banner.finish(info);
    expect(order).toEqual(["info", "flushed"]);
  });

  it("abort restores the cursor and prints nothing more", async () => {
    const { chunks, stream } = fakeStream();
    const banner = startBanner({ command: "dev", stream, env: {}, sleep: instant });
    await banner.abort();
    const out = chunks.join("");
    expect(out).toContain("\x1b[?25h");
    expect(strip(out)).not.toContain("localhost");
  });

  it("prints the settled frame for start (no animation frames)", async () => {
    const { chunks, stream } = fakeStream();
    const banner = startBanner({ command: "start", stream, env: {}, sleep: instant });
    await banner.finish(info);
    const out = chunks.join("");
    expect(out).not.toContain("\x1b[?25l");
    expect(out).not.toContain("\x1b[2A");
    const text = strip(out);
    expect(text).toContain("rpxd start");
    expect(text).toContain("─".repeat(40));
    expect(text).toContain("http://localhost:3000");
  });

  it("BORING=me skips the theatrics entirely", async () => {
    const { chunks, stream } = fakeStream();
    const banner = startBanner({ command: "dev", stream, env: { BORING: "me" }, sleep: instant });
    await banner.finish(info);
    const out = chunks.join("");
    expect(out).not.toContain("\x1b[");
    expect(out).not.toContain("(fine.)");
    expect(out).toContain("rpxd dev → http://localhost:3000");
  });
});
