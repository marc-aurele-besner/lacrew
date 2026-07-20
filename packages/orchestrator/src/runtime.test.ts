import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { CrewRuntime } from "./runtime.js";
import { MOCK_WORKER } from "@lacrew/core";

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

describe("session ceilings", () => {
  const A = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as const;

  it("issues distinct sessions per limit set", async () => {
    // Reusing a cached wide key for a tighter-scoped run would hand back the
    // authority the ceiling exists to remove.
    const runtime = new CrewRuntime();
    const wide = await runtime.boot(A);
    const tight = await runtime.boot(A, { maxValue: 1_000n });
    assert.notEqual(wide.keyId, tight.keyId);

    // Same limits reuse the same session.
    const again = await runtime.boot(A, { maxValue: 1_000n });
    assert.equal(again.keyId, tight.keyId);
  });

  it("has no ceiling to derive without an onchain policy", async () => {
    // Mock mode has no SpendCapPolicy to read, so no ceiling can be claimed.
    const runtime = new CrewRuntime();
    assert.equal(await runtime.ceilingMaxValue(A, MOCK_WORKER), undefined);
  });

  it("treats a self-scoped flow as having no ceiling", async () => {
    const runtime = new CrewRuntime();
    assert.equal(await runtime.ceilingMaxValue(A, A), undefined);
    assert.equal(await runtime.ceilingMaxValue(A, undefined), undefined);
  });
});
