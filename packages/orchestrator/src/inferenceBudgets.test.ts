import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { flow, isInferenceBudgetExceeded, type ModelPrice } from "@lacrew/flows";
import { createLacrewClient } from "@lacrew/sdk/testing";
import { CrewRuntime } from "./runtime.js";
import { createFlowsSurface } from "./flows.js";
import { createMemoryFlowStore } from "./flowStore.js";
import { createHeartbeatSurface } from "./heartbeat.js";
import { createMemoryHeartbeatStore } from "./heartbeatStore.js";
import { InMemoryQueue } from "./queue/index.js";
import { createOrchestratorApp } from "./httpApp.js";
import { createInferenceBudgets, crewIdForSeat } from "./inferenceBudgets.js";
import { createMemoryInferenceBudgetStore } from "./inferenceBudgetStore.js";
import { withInferenceBudget } from "./model/budgeted.js";
import type { ModelCompleteInput, ModelCompleteResult, ModelProvider } from "./model/types.js";

/** A provider that reports exactly the usage a test asks it to. */
function countingProvider(
  usage: { promptTokens: number; completionTokens: number },
  model = "gpt-4o-mini",
): ModelProvider & { calls: ModelCompleteInput[] } {
  const calls: ModelCompleteInput[] = [];
  return {
    name: "counting",
    calls,
    async complete(input: ModelCompleteInput): Promise<ModelCompleteResult> {
      calls.push(input);
      return { text: "ok", model: input.model ?? model, usage };
    },
  };
}

const PRICES: Record<string, ModelPrice> = {
  // $1 per million tokens each way, so a 1M-token call costs exactly $1.
  "test-model": { inputPerMTok: 1, outputPerMTok: 1 },
  cheap: { inputPerMTok: 0.01, outputPerMTok: 0.01 },
};

function budgetsSurface(notes: string[] = [], events: string[] = []) {
  return createInferenceBudgets({
    store: createMemoryInferenceBudgetStore(),
    postNote: ({ body }) => notes.push(body),
    onEvent: (event) => events.push(event.type),
  });
}

describe("the guard at ModelProvider.complete", () => {
  it("blocks the call after a hard token ceiling is reached, with a stable code", async () => {
    const budgets = budgetsSurface();
    await budgets.save({
      crewId: "trading",
      limits: { maxOutputTokens: 150 },
      policy: "hard",
      enabled: true,
    });
    const provider = countingProvider({ promptTokens: 10, completionTokens: 100 });
    const guarded = withInferenceBudget(provider, budgets, { prices: PRICES });
    const meta = { crewId: "trading", agentId: "0xaa" };

    // Two calls fit under 150 output tokens; the third is refused.
    await guarded.complete({ prompt: "one", model: "test-model", meta });
    await guarded.complete({ prompt: "two", model: "test-model", meta });
    await assert.rejects(
      () => guarded.complete({ prompt: "three", model: "test-model", meta }),
      (err: unknown) => {
        assert.ok(isInferenceBudgetExceeded(err));
        assert.equal(err.code, "inference_budget_exceeded");
        assert.equal(err.scopeKey, "crew:trading");
        assert.equal(err.dimension, "outputTokens");
        return true;
      },
    );
    // Refused before the request went out, not after it was paid for.
    assert.equal(provider.calls.length, 2);
  });

  it("lets a soft budget through, and says so once", async () => {
    const notes: string[] = [];
    const events: string[] = [];
    const budgets = budgetsSurface(notes, events);
    await budgets.save({
      crewId: "trading",
      limits: { maxOutputTokens: 100 },
      policy: "soft",
      enabled: true,
    });
    const provider = countingProvider({ promptTokens: 10, completionTokens: 100 });
    const guarded = withInferenceBudget(provider, budgets, { prices: PRICES });
    const meta = { crewId: "trading" };

    for (let i = 0; i < 3; i += 1) {
      await guarded.complete({ prompt: `p${i}`, model: "test-model", meta });
    }
    assert.equal(provider.calls.length, 3);
    // One warn crossing, one breach crossing — not one per call above the line.
    assert.deepEqual(events, ["InferenceBudgetExceeded"]);
    assert.equal(notes.length, 1);
    assert.match(notes[0]!, /INFERENCE_BUDGET_EXCEEDED/);
    assert.match(notes[0]!, /soft budget: nothing is blocked/);
  });

  it("warns at the 80% line while there is still room to act", async () => {
    const notes: string[] = [];
    const events: string[] = [];
    const budgets = budgetsSurface(notes, events);
    await budgets.save({
      crewId: "trading",
      limits: { maxOutputTokens: 100 },
      policy: "soft",
      enabled: true,
    });
    const guarded = withInferenceBudget(
      countingProvider({ promptTokens: 0, completionTokens: 40 }),
      budgets,
      { prices: PRICES },
    );
    const meta = { crewId: "trading" };
    await guarded.complete({ prompt: "a", model: "test-model", meta });
    assert.deepEqual(events, []);
    await guarded.complete({ prompt: "b", model: "test-model", meta });
    assert.deepEqual(events, ["InferenceBudgetWarned"]);
    assert.match(notes[0]!, /INFERENCE_BUDGET_WARNING/);
  });

  it("charges an agent's call to its own budget and its crew's, tightest wins", async () => {
    const budgets = budgetsSurface();
    await budgets.save({
      crewId: "trading",
      limits: { maxOutputTokens: 1_000 },
      policy: "hard",
      enabled: true,
    });
    await budgets.save({
      crewId: "trading",
      agentId: "0x00000000000000000000000000000000000000aa",
      limits: { maxOutputTokens: 50 },
      policy: "hard",
      enabled: true,
    });
    const provider = countingProvider({ promptTokens: 0, completionTokens: 60 });
    const guarded = withInferenceBudget(provider, budgets, { prices: PRICES });
    const meta = { crewId: "trading", agentId: "0x00000000000000000000000000000000000000aa" };

    await guarded.complete({ prompt: "one", model: "test-model", meta });
    // The crew has 940 tokens left; the seat has none. The seat's cap binds.
    await assert.rejects(
      () => guarded.complete({ prompt: "two", model: "test-model", meta }),
      (err: unknown) =>
        isInferenceBudgetExceeded(err) &&
        err.scopeKey === "crew:trading/agent:0x00000000000000000000000000000000000000aa",
    );
    // A different seat on the same crew is untouched by the first seat's cap.
    await guarded.complete({ prompt: "three", model: "test-model", meta: { crewId: "trading" } });
    assert.equal(provider.calls.length, 2);
  });

  it("swaps in the cheaper model once past the warn line", async () => {
    const budgets = budgetsSurface();
    await budgets.save({
      crewId: "trading",
      limits: { maxOutputTokens: 100 },
      policy: "soft",
      cheapModel: "cheap",
      enabled: true,
    });
    const provider = countingProvider({ promptTokens: 0, completionTokens: 85 });
    const guarded = withInferenceBudget(provider, budgets, { prices: PRICES });
    const meta = { crewId: "trading" };

    await guarded.complete({ prompt: "a", model: "test-model", meta });
    assert.equal(provider.calls[0]?.model, "test-model");
    await guarded.complete({ prompt: "b", model: "test-model", meta });
    assert.equal(provider.calls[1]?.model, "cheap");
  });

  it("meters a call nobody attributed rather than letting it escape the count", async () => {
    const budgets = budgetsSurface();
    const guarded = withInferenceBudget(
      countingProvider({ promptTokens: 5, completionTokens: 5 }),
      budgets,
      { prices: PRICES },
    );
    await guarded.complete({ prompt: "who am i", model: "test-model" });
    const events = await budgets.events({ crewId: "unattributed" }, 10);
    assert.equal(events.length, 1);
    assert.equal(events[0]?.scopeKey, "crew:unattributed");
  });

  it("counts an unpriced model against tokens and flags the dollar figure", async () => {
    const budgets = budgetsSurface();
    await budgets.save({
      crewId: "trading",
      limits: { maxUsd: 10, maxOutputTokens: 1_000 },
      policy: "soft",
      enabled: true,
    });
    const guarded = withInferenceBudget(
      countingProvider({ promptTokens: 10, completionTokens: 20 }),
      budgets,
      { prices: PRICES },
    );
    await guarded.complete({ prompt: "a", model: "local-llama", meta: { crewId: "trading" } });

    const view = await budgets.get({ crewId: "trading" });
    assert.equal(view?.status.usage.outputTokens, 20);
    assert.equal(view?.status.usage.usdMicros, 0);
    assert.equal(view?.status.usage.unpricedCalls, 1);
    // The $ number is a floor, and the status says so rather than implying zero.
    assert.equal(view?.status.usdIncomplete, true);
  });

  it("does not charge for a request that never reached the provider", async () => {
    const budgets = budgetsSurface();
    const failing: ModelProvider = {
      name: "failing",
      async complete() {
        throw new Error("network_down");
      },
    };
    const guarded = withInferenceBudget(failing, budgets, { prices: PRICES });
    await assert.rejects(() => guarded.complete({ prompt: "a", meta: { crewId: "trading" } }));
    assert.deepEqual(await budgets.events({ crewId: "trading" }, 10), []);
  });

  it("rolls the counter over when the period changes, and the cap bites again", async () => {
    let clock = new Date("2026-07-31T23:00:00Z");
    const budgets = createInferenceBudgets({
      store: createMemoryInferenceBudgetStore(),
      now: () => clock,
    });
    await budgets.save({
      crewId: "trading",
      limits: { maxOutputTokens: 50 },
      policy: "hard",
      enabled: true,
    });
    const guarded = withInferenceBudget(
      countingProvider({ promptTokens: 0, completionTokens: 60 }),
      budgets,
      { prices: PRICES },
    );
    const meta = { crewId: "trading" };

    await guarded.complete({ prompt: "july", model: "test-model", meta });
    await assert.rejects(() =>
      guarded.complete({ prompt: "july again", model: "test-model", meta }),
    );

    clock = new Date("2026-08-01T00:00:00Z");
    // A new month is a new counter — no sweep, no job, no migration.
    await guarded.complete({ prompt: "august", model: "test-model", meta });
    const view = await budgets.get({ crewId: "trading" });
    assert.equal(view?.status.usage.outputTokens, 60);
    assert.equal(view?.period.key, "2026-08");
  });

  it("lets a raised cap continue the same period immediately", async () => {
    const budgets = budgetsSurface();
    await budgets.save({
      crewId: "trading",
      limits: { maxOutputTokens: 50 },
      policy: "hard",
      enabled: true,
    });
    const guarded = withInferenceBudget(
      countingProvider({ promptTokens: 0, completionTokens: 60 }),
      budgets,
      { prices: PRICES },
    );
    const meta = { crewId: "trading" };
    await guarded.complete({ prompt: "a", model: "test-model", meta });
    await assert.rejects(() => guarded.complete({ prompt: "b", model: "test-model", meta }));

    await budgets.save({
      crewId: "trading",
      limits: { maxOutputTokens: 500 },
      policy: "hard",
      enabled: true,
    });
    // The counter did not move; the limit it is compared against did.
    await guarded.complete({ prompt: "c", model: "test-model", meta });
  });

  it("enforces nothing while a budget is disabled", async () => {
    const budgets = budgetsSurface();
    await budgets.save({
      crewId: "trading",
      limits: { maxOutputTokens: 1 },
      policy: "hard",
      enabled: false,
    });
    const guarded = withInferenceBudget(
      countingProvider({ promptTokens: 0, completionTokens: 60 }),
      budgets,
      { prices: PRICES },
    );
    await guarded.complete({ prompt: "a", model: "test-model", meta: { crewId: "trading" } });
    // Still metered, so enabling it later does not read as a crew that has
    // never spent anything.
    const events = await budgets.events({ crewId: "trading" }, 10);
    assert.equal(events.length, 1);
  });
});

describe("crew attribution", () => {
  it("charges a seat to its nearest manager, or to itself when it has none", () => {
    assert.equal(crewIdForSeat("0xWORKER", ["0xMANAGER", "0xROOT"]), "0xmanager");
    assert.equal(crewIdForSeat("0xROOT", []), "0xroot");
  });
});

describe("budget routes", () => {
  async function buildApp() {
    const runtime = new CrewRuntime({ client: createLacrewClient({ useMock: true }) });
    const budgets = budgetsSurface();
    const model = withInferenceBudget(
      countingProvider({ promptTokens: 0, completionTokens: 60 }),
      budgets,
      { prices: PRICES },
    );
    const flows = createFlowsSurface({ runtime, model, store: createMemoryFlowStore() });
    const app = createOrchestratorApp({
      runtime,
      queue: new InMemoryQueue(),
      model,
      flows,
      budgets,
      mcpUseMock: true,
      isDbReady: () => false,
      isDbConfigured: () => false,
    });
    return { app, budgets, runtime };
  }

  const post = (app: Awaited<ReturnType<typeof buildApp>>["app"], path: string, body: unknown) =>
    app.request(path, {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
    });

  it("saves, lists, toggles and removes a budget", async () => {
    const { app, runtime } = await buildApp();
    const saved = await post(app, "/budgets", {
      budget: {
        crewId: "Trading",
        limits: { maxUsd: 25 },
        policy: "hard",
        enabled: true,
      },
    });
    assert.equal(saved.status, 200);

    const listed = (await (await app.request("/budgets")).json()) as {
      budgets: Array<{ scopeKey: string; budget: { crewId: string; enabled: boolean } }>;
      warnRatio: number;
    };
    assert.equal(listed.budgets.length, 1);
    assert.equal(listed.budgets[0]?.scopeKey, "crew:trading");
    assert.equal(listed.warnRatio, 0.8);

    const off = await post(app, "/budgets/enabled", { crewId: "trading", enabled: false });
    assert.equal(off.status, 200);
    assert.equal(((await off.json()) as { budget: { enabled: boolean } }).budget.enabled, false);

    // Raising or removing a cap is what lets a stopped crew spend again, so it
    // is in the trail.
    const trail = (await runtime.audit()).map((e) => e.type);
    assert.ok(trail.includes("InferenceBudgetChanged"));

    const removed = await post(app, "/budgets/delete", { crewId: "trading" });
    assert.equal(((await removed.json()) as { removed: boolean }).removed, true);
    assert.equal(
      (await post(app, "/budgets/enabled", { crewId: "trading", enabled: true })).status,
      404,
    );
  });

  it("refuses a budget that bounds nothing, and one with a bad address", async () => {
    const { app } = await buildApp();
    const nothing = await post(app, "/budgets", {
      budget: { crewId: "trading", limits: {}, enabled: true },
    });
    assert.equal(nothing.status, 400);
    assert.match(((await nothing.json()) as { error: string }).error, /at least one of maxUsd/);

    const badAgent = await post(app, "/budgets", {
      budget: { crewId: "trading", agentId: "nope", limits: { maxUsd: 1 }, enabled: true },
    });
    assert.equal(badAgent.status, 400);
  });

  it("answers a refused completion with 429 and the stable code", async () => {
    const { app } = await buildApp();
    await post(app, "/budgets", {
      budget: {
        crewId: "trading",
        limits: { maxOutputTokens: 50 },
        policy: "hard",
        enabled: true,
      },
    });
    assert.equal(
      (await post(app, "/model/complete", { prompt: "a", model: "test-model", crewId: "trading" }))
        .status,
      200,
    );
    const refused = await post(app, "/model/complete", {
      prompt: "b",
      model: "test-model",
      crewId: "trading",
    });
    assert.equal(refused.status, 429);
    const body = (await refused.json()) as { error: string; dimension: string };
    assert.equal(body.error, "inference_budget_exceeded");
    assert.equal(body.dimension, "outputTokens");
  });

  it("exports the calls behind the number", async () => {
    const { app } = await buildApp();
    await post(app, "/budgets", {
      budget: { crewId: "trading", limits: { maxUsd: 5 }, policy: "soft", enabled: true },
    });
    await post(app, "/model/complete", { prompt: "a", model: "test-model", crewId: "trading" });

    const usage = (await (await app.request("/budgets/usage?crewId=trading")).json()) as {
      events: Array<{ model: string; outputTokens: number; priceSource: string }>;
    };
    assert.equal(usage.events.length, 1);
    assert.equal(usage.events[0]?.model, "test-model");
    assert.equal(usage.events[0]?.outputTokens, 60);
    assert.equal(usage.events[0]?.priceSource, "table");
  });

  it("reports how many budgets actually bite on /health", async () => {
    const { app } = await buildApp();
    await post(app, "/budgets", {
      budget: { crewId: "a", limits: { maxUsd: 1 }, policy: "hard", enabled: true },
    });
    await post(app, "/budgets", {
      budget: { crewId: "b", limits: { maxUsd: 1 }, policy: "soft", enabled: false },
    });
    const health = (await (await app.request("/health")).json()) as {
      budgets: { configured: number; enabled: number; hard: number };
    };
    assert.equal(health.budgets.configured, 2);
    assert.equal(health.budgets.enabled, 1);
    assert.equal(health.budgets.hard, 1);
  });
});

describe("heartbeat under a hard breach", () => {
  it("stops the timer rather than filling the thread with refusals", async () => {
    const runtime = new CrewRuntime({ client: createLacrewClient({ useMock: true }) });
    const budgets = budgetsSurface();
    await budgets.save({
      crewId: "trading",
      limits: { maxOutputTokens: 1 },
      policy: "hard",
      pauseHeartbeatOnBreach: true,
      enabled: true,
    });
    const guarded = withInferenceBudget(
      countingProvider({ promptTokens: 0, completionTokens: 60 }),
      budgets,
      { prices: PRICES },
    );
    const flows = createFlowsSurface({ runtime, model: guarded, store: createMemoryFlowStore() });
    await flows.save(flow("digest", "Digest").model("write", { prompt: "go" }).build());
    const heartbeats = createHeartbeatSurface({
      runtime,
      flows,
      store: createMemoryHeartbeatStore(),
      budgetBlock: async () => budgets.heartbeatBlock("trading"),
    });
    await heartbeats.save({
      crewId: "trading",
      schedule: "*/30 * * * *",
      checklist: [{ kind: "flow", id: "digest" }],
      enabled: true,
    });

    // Nothing is over the line yet, so the tick runs.
    await heartbeats.runNow("trading");
    // Then the crew spends past a 1-token ceiling. The next press is refused
    // with a reason, not with a list of identical item failures.
    await guarded.complete({ prompt: "spend", model: "test-model", meta: { crewId: "trading" } });
    await assert.rejects(() => heartbeats.runNow("trading"), /inference_budget_exceeded/);

    // And the scheduled sweep leaves no tick row at all.
    const before = (await heartbeats.ticks(50, "trading")).length;
    await heartbeats.sweep(new Date("2026-07-30T12:30:00Z"));
    assert.equal((await heartbeats.ticks(50, "trading")).length, before);
  });

  it("leaves the timer alone when the operator turned that off", async () => {
    const budgets = budgetsSurface();
    await budgets.save({
      crewId: "trading",
      limits: { maxOutputTokens: 1 },
      policy: "hard",
      pauseHeartbeatOnBreach: false,
      enabled: true,
    });
    const guarded = withInferenceBudget(
      countingProvider({ promptTokens: 0, completionTokens: 60 }),
      budgets,
      { prices: PRICES },
    );
    await guarded.complete({ prompt: "a", model: "test-model", meta: { crewId: "trading" } });
    // The call guard still refuses; only the heartbeat hold is opted out of.
    assert.equal(await budgets.heartbeatBlock("trading"), null);
    assert.notEqual(await budgets.blockedBy({ crewId: "trading" }), null);
  });
});
