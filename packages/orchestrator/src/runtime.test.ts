import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { CrewRuntime, createRuntimeFromEnv } from "./runtime.js";
import { ADDRESS_ENV_VARS, ANVIL_CHAIN_ID, MOCK_WORKER } from "@lacrew/core";
import { createLacrewClient } from "@lacrew/sdk/testing";

describe("CrewRuntime", () => {
  it("lists pending mock intents after construct", async () => {
    const runtime = new CrewRuntime({ client: createLacrewClient({ useMock: true }) });
    const pending = await runtime.listPending();
    assert.ok(Array.isArray(pending));
    assert.ok(pending.length >= 1);
  });

  it("defaults to mock mode without ANVIL env", () => {
    const runtime = new CrewRuntime({ client: createLacrewClient({ useMock: true }) });
    assert.equal(runtime.mode, "mock");
  });

  it("records local audit on mock tick and resolve", async () => {
    const runtime = new CrewRuntime({ client: createLacrewClient({ useMock: true }) });
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
    const runtime = new CrewRuntime({ client: createLacrewClient({ useMock: true }) });
    const wide = await runtime.boot(A);
    const tight = await runtime.boot(A, { maxValue: 1_000n });
    assert.notEqual(wide.keyId, tight.keyId);

    // Same limits reuse the same session.
    const again = await runtime.boot(A, { maxValue: 1_000n });
    assert.equal(again.keyId, tight.keyId);
  });

  it("has no ceiling to derive without an onchain policy", async () => {
    // Mock mode has no SpendCapPolicy to read, so no ceiling can be claimed.
    const runtime = new CrewRuntime({ client: createLacrewClient({ useMock: true }) });
    assert.equal(await runtime.ceilingMaxValue(A, MOCK_WORKER), undefined);
  });

  it("treats a self-scoped flow as having no ceiling", async () => {
    const runtime = new CrewRuntime({ client: createLacrewClient({ useMock: true }) });
    assert.equal(await runtime.ceilingMaxValue(A, A), undefined);
    assert.equal(await runtime.ceilingMaxValue(A, undefined), undefined);
  });
});

describe("no demo address stands in for a real seat", () => {
  it("refuses an onchain runtime that names no seats", () => {
    // Left to default, the seats would be MOCK_WORKER / MOCK_MANAGER: the
    // runtime would sign as an agent the org never hired.
    assert.throws(
      () =>
        new CrewRuntime({
          client: createLacrewClient({ useMock: true }),
          mode: "onchain",
          chainId: ANVIL_CHAIN_ID,
        }),
      /workerAgent, managerAgent, spendTarget/,
    );
  });

  it("names only the seat that is missing", () => {
    assert.throws(
      () =>
        new CrewRuntime({
          client: createLacrewClient({ useMock: true }),
          mode: "onchain",
          chainId: ANVIL_CHAIN_ID,
          workerAgent: MOCK_WORKER,
          managerAgent: MOCK_WORKER,
        }),
      /^Error: An onchain CrewRuntime needs spendTarget;/,
    );
  });

  it("reports an address book with contracts but no seats", async () => {
    // A local chain described entirely through LACREW_* overrides: the
    // registry is named, the seats are not.
    const keys = ["ANVIL_RPC", "PRIVATE_KEY", "CHAIN_ID", ADDRESS_ENV_VARS.orgRegistry] as const;
    const restore = keys.map((k) => [k, process.env[k]] as const);
    // Unreachable on purpose: a seatless address book is a config gap, so it
    // must be reported without a chain round-trip.
    process.env.ANVIL_RPC = "http://127.0.0.1:1";
    process.env.PRIVATE_KEY = `0x${"1".repeat(64)}`;
    process.env.CHAIN_ID = "31338";
    process.env[ADDRESS_ENV_VARS.orgRegistry] = `0x${"ab".repeat(20)}`;
    try {
      const boot = await createRuntimeFromEnv();
      assert.equal(boot.ok, false);
      assert.equal(boot.ok === false && boot.reason, "incomplete_deployment");
      assert.match(boot.ok === false ? boot.detail : "", /worker, manager, x402Target/);
    } finally {
      for (const [key, value] of restore) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});
