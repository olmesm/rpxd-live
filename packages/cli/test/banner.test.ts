import { describe, expect, it } from "vitest";
import {
  type BannerInfo,
  bannerMode,
  colorizeRow,
  infoLines,
  pickScale,
  plainLines,
  renderRollFrame,
  rollOffsets,
  startBanner,
  wordmark,
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

describe("wordmark", () => {
  it("is 5 rows of equal width built from block glyphs", () => {
    const mark = wordmark(1);
    expect(mark).toHaveLength(5);
    const widths = new Set(mark.map((r) => r.length));
    expect(widths.size).toBe(1);
    for (const row of mark) expect(row).toMatch(/^[█▀▄ ]+$/);
  });

  it("scales horizontally by repeating columns", () => {
    const base = wordmark(1)[0] as string;
    const wide = wordmark(4)[0] as string;
    expect(wide.length).toBe(base.length * 4);
    // Stretching preserves the glyph sequence: dedup of runs matches.
    expect(wide.replace(/(.)\1*/g, "$1")).toBe(base.replace(/(.)\1*/g, "$1"));
  });
});

describe("pickScale", () => {
  it("targets ~150 cols on ultrawide, ~120 on wide, ~90 on standard", () => {
    const markW = (wordmark(1)[0] as string).length;
    expect(pickScale(200) * markW).toBe(150);
    expect(pickScale(160) * markW).toBe(150);
    expect(pickScale(140) * markW).toBe(120);
    expect(pickScale(100) * markW).toBe(90);
  });

  it("returns 0 below the animatable minimum", () => {
    expect(pickScale(80)).toBe(0);
  });
});

describe("rollOffsets", () => {
  it("eases from off-screen right to an overshoot past the left margin, then rests at 0", () => {
    const offsets = rollOffsets(120, 30);
    expect(offsets[0]).toBeLessThan(120); // a sliver is visible immediately
    expect(offsets[0]).toBeGreaterThan(0);
    expect(offsets.at(-1)).toBe(0); // rests at the left margin
    expect(offsets.at(-2)).toBeLessThan(0); // one-frame overshoot "thunk"
    const gliding = offsets.slice(0, -2);
    for (let i = 1; i < gliding.length; i++) {
      expect(gliding[i] as number).toBeLessThanOrEqual(gliding[i - 1] as number);
    }
  });
});

describe("renderRollFrame", () => {
  const mark = wordmark(1);

  it("places the mark at the offset and never exceeds the width", () => {
    const rows = renderRollFrame(mark, 10, 120, 0);
    expect(rows[0]).toBe(`${" ".repeat(10)}${mark[0]}`);
    for (const row of rows) expect(row.length).toBeLessThanOrEqual(120);
  });

  it("clips at the right edge on entry", () => {
    const markW = (mark[0] as string).length;
    const rows = renderRollFrame(mark, 120 - 5, 120, 0);
    for (const row of rows) expect(row.length).toBeLessThanOrEqual(120);
    expect((rows[0] as string).trimStart().length).toBeLessThan(markW);
  });

  it("clips at the left edge on overshoot", () => {
    const rows = renderRollFrame(mark, -2, 120, 0);
    expect(rows[0]).toBe((mark[0] as string).slice(2));
  });

  it("draws a fading speed-line trail behind the mark while moving", () => {
    const rows = renderRollFrame(mark, 20, 120, 6);
    expect(rows[0]).toContain("▓");
    expect(rows[0]).toContain("░");
    // Dense shading sits nearest the mark, light shading trails furthest.
    expect((rows[0] as string).indexOf("▓")).toBeLessThan((rows[0] as string).indexOf("░"));
  });

  it("at rest with no trail, reproduces the wordmark at the margin", () => {
    const rows = renderRollFrame(mark, 0, 120, 0);
    expect(rows).toEqual(mark.map((r) => r.trimEnd()));
  });
});

describe("infoLines", () => {
  it("frames the server summary between rules of the banner width", () => {
    const lines = infoLines(info, 90, false);
    expect(lines[0]).toBe("─".repeat(90));
    expect(lines.at(-1)).toBe("─".repeat(90));
    const body = lines.join("\n");
    expect(body).toContain("http://localhost:3000");
    expect(body).toContain("transport ws");
    expect(body).toContain("rsc on");
    expect(body).toContain("14 routes");
    expect(body).toContain("ready in 412 ms");
    expect(body).toContain("v0.1.0");
  });

  it("includes the network URL only when one exists", () => {
    const withLan = infoLines({ ...info, networkUrl: "http://192.168.1.24:3000" }, 90, false);
    expect(withLan.join("\n")).toContain("http://192.168.1.24:3000");
    expect(infoLines(info, 90, false).join("\n")).not.toContain("network");
  });

  it("omits optional segments it has no data for", () => {
    const lines = infoLines({ ...info, version: undefined, readyMs: undefined }, 90, false);
    const body = lines.join("\n");
    expect(body).not.toContain("ready in");
    expect(body).not.toContain(" v");
  });
});

describe("plainLines (boring/CI output)", () => {
  it("acknowledges the documented incantation with a deadpan (fine.)", () => {
    const lines = plainLines(info, { BORING: "me" });
    expect(lines[0]).toContain("rpxd dev → http://localhost:3000");
    expect(lines[0]).toContain("(fine.)");
  });

  it("still disables for any other BORING value, without the easter egg", () => {
    const lines = plainLines(info, { BORING: "1" });
    expect(lines[0]).toContain("http://localhost:3000");
    expect(lines.join("\n")).not.toContain("(fine.)");
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
  const tty = { isTTY: true, columns: 140 };

  it("goes full in a wide interactive terminal", () => {
    expect(bannerMode({}, tty)).toBe("full");
  });

  it.each([
    ["BORING set", { BORING: "me" }, tty],
    ["CI", { CI: "true" }, tty],
    ["dumb terminal", { TERM: "dumb" }, tty],
    ["not a TTY", {}, { isTTY: false, columns: 140 }],
    ["too narrow", {}, { isTTY: true, columns: 80 }],
  ] as const)("falls back to plain when %s", (_reason, env, stream) => {
    expect(bannerMode(env, stream)).toBe("plain");
  });
});

describe("colorizeRow", () => {
  const row = "  ██▀▄ ▓▒░";

  it("wraps glyphs in 24-bit color and leaves visible text unchanged", () => {
    const painted = colorizeRow(row, 2, 4, true);
    expect(painted).toContain("\x1b[38;2;");
    expect(strip(painted)).toBe(row);
  });

  it("is the identity when color is disabled", () => {
    expect(colorizeRow(row, 2, 4, false)).toBe(row);
  });
});

describe("startBanner", () => {
  const instant = (): Promise<void> => Promise.resolve();

  function fakeStream(columns = 140, isTTY = true) {
    const chunks: string[] = [];
    return {
      chunks,
      stream: { isTTY, columns, write: (s: string) => void chunks.push(s) },
    };
  }

  it("animates the roll then prints the server info (dev, full mode)", async () => {
    const { chunks, stream } = fakeStream();
    const banner = startBanner({ command: "dev", stream, env: {}, sleep: instant });
    await banner.finish(info);
    const out = chunks.join("");
    expect(out).toContain("\x1b[?25l"); // cursor hidden during the roll
    expect(out).toContain("\x1b[?25h"); // and restored
    expect(out).toContain("\x1b[5A"); // frames rewrite in place
    expect(strip(out)).toContain("██"); // the wordmark landed
    expect(strip(out)).toContain("http://localhost:3000");
    expect(strip(out)).toContain("transport ws");
  });

  it("buffers console output during the roll and flushes it afterwards", async () => {
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
    expect(logged).toEqual([["boot noise"]]); // replayed once the banner locked
    fakeConsole.log("after");
    expect(logged.at(-1)).toEqual(["after"]); // console restored
  });

  it("flushes buffered logs after the info block, not between wordmark and summary", async () => {
    const order: string[] = [];
    const stream = {
      isTTY: true,
      columns: 140,
      write: (s: string) => void (strip(s).includes("localhost") && order.push("info")),
    };
    const fakeConsole = { log: () => void order.push("flushed") };
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

  it("prints the static locked frame for start (no animation frames)", async () => {
    const { chunks, stream } = fakeStream();
    const banner = startBanner({ command: "start", stream, env: {}, sleep: instant });
    await banner.finish(info);
    const out = chunks.join("");
    expect(out).not.toContain("\x1b[?25l");
    expect(out).not.toContain("\x1b[5A");
    expect(strip(out)).toContain("██");
    expect(strip(out)).toContain("http://localhost:3000");
  });

  it("BORING=me skips the theatrics entirely", async () => {
    const { chunks, stream } = fakeStream();
    const banner = startBanner({ command: "dev", stream, env: { BORING: "me" }, sleep: instant });
    await banner.finish(info);
    const out = chunks.join("");
    expect(out).not.toContain("\x1b[");
    expect(out).toContain("(fine.)");
    expect(out).toContain("http://localhost:3000");
  });
});
