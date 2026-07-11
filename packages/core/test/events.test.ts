import { describe, expect, it, vi } from "vitest";
import { defaultEventSink, makeEmit, type RpxdEvent } from "../src/events.ts";

describe("defaultEventSink", () => {
  it("routes each level to the matching console method with a [rpxd] category/type label", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const debug = vi.spyOn(console, "debug").mockImplementation(() => {});
    try {
      defaultEventSink({
        category: "instance",
        type: "load-failed",
        level: "error",
        error: new Error("boom"),
      });
      defaultEventSink({
        category: "security",
        type: "rate-limited",
        level: "warn",
        detail: { key: "k" },
      });
      defaultEventSink({ category: "request", type: "request-failed", level: "info" });
      defaultEventSink({ category: "storage", type: "subscriber-threw", level: "debug" });
      expect(error).toHaveBeenCalledWith(
        expect.stringContaining("instance/load-failed"),
        expect.anything(),
      );
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("security/rate-limited"), {
        key: "k",
      });
      expect(info).toHaveBeenCalledWith(expect.stringContaining("request/request-failed"));
      expect(debug).toHaveBeenCalledWith(expect.stringContaining("storage/subscriber-threw"));
    } finally {
      error.mockRestore();
      warn.mockRestore();
      info.mockRestore();
      debug.mockRestore();
    }
  });
});

describe("makeEmit", () => {
  it("forwards structured events to the wrapped sink", () => {
    const seen: RpxdEvent[] = [];
    const emit = makeEmit((e) => seen.push(e));
    emit({ category: "instance", type: "flush-failed", level: "error", error: new Error("x") });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ category: "instance", type: "flush-failed", level: "error" });
  });

  it("swallows a throw from the sink so observability can't break the caller", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const emit = makeEmit(() => {
        throw new Error("sink blew up");
      });
      expect(() =>
        emit({ category: "instance", type: "load-failed", level: "error" }),
      ).not.toThrow();
      expect(spy).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it("defaults to defaultEventSink when no sink is passed", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const emit = makeEmit();
      emit({
        category: "storage",
        type: "redis-publish-failed",
        level: "error",
        error: new Error("y"),
      });
      expect(spy).toHaveBeenCalledWith(
        expect.stringContaining("storage/redis-publish-failed"),
        expect.anything(),
      );
    } finally {
      spy.mockRestore();
    }
  });
});
