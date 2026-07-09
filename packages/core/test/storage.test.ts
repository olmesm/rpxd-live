import { describe, expect, it } from "vitest";
import { type BroadcastMessage, LocalBus } from "../src/storage.ts";

const msg = (over: Partial<BroadcastMessage> = {}): BroadcastMessage => ({
  topic: "room:1",
  event: "hi",
  payload: {},
  senderId: "inst-x",
  self: true,
  ...over,
});

describe("LocalBus subscriber isolation", () => {
  it("keeps delivering to remaining subscribers when one throws", () => {
    const bus = new LocalBus();
    const seen: string[] = [];
    bus.subscribe("room:1", "a", () => {
      throw new Error("subscriber A blew up");
    });
    bus.subscribe("room:1", "b", () => {
      seen.push("b");
    });

    // The throwing subscriber must neither abort fan-out to B nor propagate
    // out of publish() into the broadcasting rpc handler.
    expect(() => bus.publish(msg())).not.toThrow();
    expect(seen).toEqual(["b"]);
  });

  it("does not propagate a subscriber error to the publisher", () => {
    const bus = new LocalBus();
    bus.subscribe("room:1", "only", () => {
      throw new Error("boom");
    });
    expect(() => bus.publish(msg())).not.toThrow();
  });
});
