import { describe, expect, it } from "vitest";
import { rpxdEntryPlugin } from "../src/entry.ts";

const VIRTUAL_ID = "\0rpxd-entry.tsx";

function entrySource(opts: Parameters<typeof rpxdEntryPlugin>[0]) {
  const plugin = rpxdEntryPlugin(opts);
  const load = plugin.load as (id: string) => string | undefined;
  return load.call(plugin, VIRTUAL_ID) ?? "";
}

describe("client entry template (§11 transport parity)", () => {
  it("defaults to SSE — no transport override in the connection", () => {
    const source = entrySource({});
    expect(source).toContain("new LiveConnection({");
    expect(source).not.toContain('transport: "ws"');
  });

  it("bakes transport: ws into the connection when configured", () => {
    const source = entrySource({ transport: "ws" });
    expect(source).toContain('transport: "ws"');
  });

  it("keeps rsc hydration wiring independent of transport", () => {
    const source = entrySource({ rsc: true, transport: "ws" });
    expect(source).toContain("hydrateRscFields");
    expect(source).toContain('transport: "ws"');
  });
});
