/**
 * `/chat` multiplayer at the harness level (§8) — the logic twin of
 * `e2e/tests/chat.spec.ts`. The e2e proves cross-CONTEXT delivery over a real
 * SSE/WS transport (the browser-shaped kernel); this pins the route's
 * single-code-path contract without a browser: the `send` rpc ONLY broadcasts
 * with `{ self: true }`, and ALL mutation happens in the `on("message.created")`
 * handler — so the sender sees its own message through the bus, not a separate
 * optimistic path, and a peer sharing the storage bus sees it too.
 */
import { describe, expect, it } from "bun:test";
import { memory } from "@rpxd/core";
import { testLive } from "@rpxd/testing";
import route from "../routes/chat.tsx";

describe("chat route multiplayer (single-code-path, self:true)", () => {
  it("the sender sees its own message via self:true — mutation only in the on-handler", async () => {
    const t = await testLive(route, { id: "solo" });
    await t.rpc.send({ text: "hello" });
    await t.settled();
    // No optimistic path exists on `send`; the message is only on screen because
    // the self-delivered broadcast ran the `on` handler.
    expect(t.state.messages.map((m) => m.text)).toEqual(["hello"]);
    await t.dispose();
  });

  it("two sessions on the shared bus both see a message (fan-out + self)", async () => {
    const storage = memory();
    const alice = await testLive(route, { storage, id: "alice" });
    const bob = await testLive(route, { storage, id: "bob" });

    await alice.rpc.send({ text: "hi from alice" });
    await alice.settled();
    await bob.settled();

    // self:true → alice sees her own; the bus → bob sees it too.
    expect(alice.state.messages.map((m) => m.text)).toEqual(["hi from alice"]);
    expect(bob.state.messages.map((m) => m.text)).toEqual(["hi from alice"]);

    // And back the other way.
    await bob.rpc.send({ text: "hi from bob" });
    await bob.settled();
    await alice.settled();
    expect(alice.state.messages.map((m) => m.text)).toEqual(["hi from alice", "hi from bob"]);
    expect(bob.state.messages.map((m) => m.text)).toEqual(["hi from alice", "hi from bob"]);

    await alice.dispose();
    await bob.dispose();
  });
});
