import { describe, expect, it } from "vitest";
import { createLatestWinsReloader } from "../src/reload-serializer.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("createLatestWinsReloader (reducer HMR ordering, #67)", () => {
  it("applies the newer def when two reloads of the same key resolve out of order", async () => {
    const applied: Array<{ key: string; value: string }> = [];
    const reload = createLatestWinsReloader<string>((key, value) => {
      applied.push({ key, value });
    });

    const first = deferred<string>();
    const second = deferred<string>();

    // Two rapid saves of the same file: the older reload is still in-flight
    // when the newer one starts.
    const p1 = reload("/counter", () => first.promise);
    const p2 = reload("/counter", () => second.promise);

    // Imports resolve OUT OF ORDER: the newer reload resolves first...
    second.resolve("new");
    await p2;
    // ...then the stale older reload resolves afterwards.
    first.resolve("old");
    await p1;

    // The instance must end up on the newest def, and the stale reload must
    // never clobber it.
    expect(applied.map((a) => a.value)).toEqual(["new"]);
  });

  it("does not cross keys: independent files each keep their own newest def", async () => {
    const applied: Array<{ key: string; value: string }> = [];
    const reload = createLatestWinsReloader<string>((key, value) => {
      applied.push({ key, value });
    });

    await reload("/a", () => Promise.resolve("a1"));
    await reload("/b", () => Promise.resolve("b1"));

    expect(applied).toEqual([
      { key: "/a", value: "a1" },
      { key: "/b", value: "b1" },
    ]);
  });
});
