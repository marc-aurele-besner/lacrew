import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { CrewRuntime } from "./runtime.js";

describe("CrewRuntime", () => {
  it("lists pending mock intents after construct", async () => {
    const runtime = new CrewRuntime();
    const pending = await runtime.listPending();
    assert.ok(Array.isArray(pending));
    assert.ok(pending.length >= 1);
  });

  it("defaults to mock mode without ANVIL env", () => {
    const runtime = new CrewRuntime();
    assert.equal(runtime.mode, "mock");
  });

  it("records local audit on mock tick and resolve", async () => {
    const runtime = new CrewRuntime();
    const tick = await runtime.tick();
    assert.equal(tick.verdict, "ESCALATE");
    const afterTick = await runtime.audit();
    assert.ok(afterTick.some((e) => e.type === "IntentCreated" || e.type === "SessionIssued"));

    await runtime.resolve(tick.intentId, true);
    const afterResolve = await runtime.audit();
    assert.ok(afterResolve.some((e) => e.type === "IntentResolved"));
  });
});
