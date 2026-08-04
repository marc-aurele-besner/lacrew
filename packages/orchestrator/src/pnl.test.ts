/**
 * The crew / seat P&L surface and its route (F2.33).
 *
 * Driven through the real runtime, the real budgets surface and the real app:
 * what is worth asserting is that three separately-kept meters land on one page
 * with the same period and honest provenance, and a stubbed store would assert
 * the wiring instead of the report.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createLacrewClient } from "@lacrew/sdk/testing";
import { MOCK_MANAGER, MOCK_ROOT, MOCK_WORKER } from "@lacrew/core";
import { createOrchestratorApp } from "./httpApp.js";
import { createInferenceBudgets } from "./inferenceBudgets.js";
import { createMemoryInferenceBudgetStore } from "./inferenceBudgetStore.js";
import { MemoryModelProvider } from "./model/index.js";
import { InMemoryQueue } from "./queue/index.js";
import { CrewRuntime } from "./runtime.js";
import { connectorPricesFromEnv, createPnl } from "./pnl.js";

const AT = "2026-07-10T12:00:00.000Z";
const FROM = "2026-07-01T00:00:00.000Z";
const TO = "2026-08-01T00:00:00.000Z";
const OUTSIDER = "0x9999999999999999999999999999999999999999";

function harness(opts: { connectorPrices?: Record<string, number> } = {}) {
  const runtime = new CrewRuntime({
    client: createLacrewClient({ useMock: true }),
  });
  const budgets = createInferenceBudgets({
    store: createMemoryInferenceBudgetStore(),
    now: () => new Date(AT),
  });
  const pnl = createPnl({
    runtime,
    budgets,
    connectorPrices: opts.connectorPrices ?? null,
    now: () => new Date(AT),
  });
  const app = createOrchestratorApp({
    runtime,
    queue: new InMemoryQueue(),
    model: new MemoryModelProvider(),
    flows: undefined as never,
    budgets,
    pnl,
    mcpUseMock: true,
    isDbReady: () => false,
    isDbConfigured: () => false,
  });
  return { runtime, budgets, pnl, app };
}

/** One settled spend, one open escalation, one epoch grant, two tool calls. */
function seedTrail(runtime: CrewRuntime): void {
  runtime.recordAudit({
    type: "AllowanceSpent",
    at: "2026-07-02T10:00:00.000Z",
    payload: {
      agent: MOCK_WORKER,
      target: OUTSIDER,
      value: "50000000",
      txHash: "0xspend",
    },
  });
  runtime.recordAudit({
    type: "ActionExecuted",
    at: "2026-07-02T10:00:04.000Z",
    payload: {
      agent: MOCK_WORKER,
      target: OUTSIDER,
      value: "50000000",
      txHash: "0xspend",
    },
  });
  runtime.recordAudit({
    type: "IntentCreated",
    at: "2026-07-03T10:00:00.000Z",
    payload: {
      intentId: "42",
      agent: MOCK_WORKER,
      target: OUTSIDER,
      value: "75000000",
    },
  });
  runtime.recordAudit({
    type: "AllowanceStreamed",
    at: "2026-07-01T00:01:00.000Z",
    payload: { node: MOCK_WORKER, amount: "200000000", epoch: 3 },
  });
  runtime.recordAudit({
    type: "ToolCalled",
    at: "2026-07-04T09:00:00.000Z",
    payload: {
      connector: "github",
      route: "merge_pr",
      method: "POST",
      effect: "write",
      status: 200,
      ok: true,
      crewId: MOCK_MANAGER.toLowerCase(),
      agentId: MOCK_WORKER.toLowerCase(),
    },
  });
  runtime.recordAudit({
    type: "ToolCalled",
    at: "2026-07-04T09:05:00.000Z",
    payload: {
      connector: "github",
      route: "list_prs",
      method: "GET",
      effect: "read",
      status: 500,
      ok: false,
      crewId: MOCK_MANAGER.toLowerCase(),
      agentId: MOCK_WORKER.toLowerCase(),
    },
  });
  // Another desk's row on the same trail.
  runtime.recordAudit({
    type: "AllowanceSpent",
    at: "2026-07-05T10:00:00.000Z",
    payload: {
      agent: OUTSIDER,
      target: OUTSIDER,
      value: "900000000",
      txHash: "0xother",
    },
  });
}

async function meter(
  budgets: ReturnType<typeof createInferenceBudgets>,
  over: { agentId?: string; usdMicros: number | null },
): Promise<void> {
  await budgets.record(
    {
      crewId: MOCK_MANAGER.toLowerCase(),
      ...(over.agentId ? { agentId: over.agentId } : {}),
    },
    {
      model: "claude-sonnet-5",
      inputTokens: 1_000,
      outputTokens: 250,
      usdMicros: over.usdMicros,
      priceSource: over.usdMicros === null ? "none" : "provider",
      tokensEstimated: false,
      flowId: "daily-brief",
    },
  );
}

describe("crew P&L", () => {
  it("puts the three meters on one period, with the crew's own roster", async () => {
    const h = harness();
    seedTrail(h.runtime);
    await meter(h.budgets, {
      agentId: MOCK_WORKER.toLowerCase(),
      usdMicros: 4_500,
    });

    const report = await h.pnl.report({
      crewId: MOCK_MANAGER,
      from: FROM,
      to: TO,
    });

    assert.equal(report.scope.kind, "crew");
    assert.equal(report.period.timezone, "UTC");
    assert.equal(report.asOf, AT);

    const usdc = report.totals.onchain.assets.find((a) => a.asset === "USDC")!;
    assert.equal(usdc.spent, "50000000");
    assert.equal(usdc.pending, "75000000");
    assert.equal(usdc.granted, "200000000");

    assert.equal(report.totals.inference.calls, 1);
    assert.equal(report.totals.inference.usdMicros, 4_500);

    assert.equal(report.totals.connectors.calls, 2);
    assert.equal(report.totals.connectors.writes, 1);
    assert.equal(report.totals.connectors.failed, 1);

    // The manager and everything reporting to it — never the root above it.
    assert.deepEqual(
      report.seats.map((s) => s.agentId).sort(),
      [MOCK_MANAGER.toLowerCase(), MOCK_WORKER.toLowerCase()].sort(),
    );
    const worker = report.seats.find((s) => s.agentId === MOCK_WORKER.toLowerCase())!;
    assert.equal(worker.inference.usdMicros, 4_500);
    assert.equal(worker.onchain.assets.find((a) => a.asset === "USDC")!.spent, "50000000");
  });

  it("charges a seat's call to its crew without counting it twice", async () => {
    const h = harness();
    await meter(h.budgets, {
      agentId: MOCK_WORKER.toLowerCase(),
      usdMicros: 4_500,
    });
    await meter(h.budgets, { usdMicros: 1_000 }); // charged to the crew, no seat

    const report = await h.pnl.report({
      crewId: MOCK_MANAGER,
      from: FROM,
      to: TO,
    });
    assert.equal(report.totals.inference.calls, 2);
    assert.equal(report.totals.inference.usdMicros, 5_500);
    const seatCalls = report.seats.reduce((n, s) => n + s.inference.calls, 0);
    assert.equal(seatCalls, 1);
    assert.equal(report.unattributed.inference.calls, 1);
    assert.ok(report.notes.some((n) => n.includes("without naming a seat")));
  });

  it("counts the manager's own calls, which the runtime charges to the crew above", async () => {
    const h = harness();
    // A manager reports to the human root, so its own completions are metered
    // under `crew:<root>/agent:<manager>` — outside this crew's own key.
    await h.budgets.record(
      { crewId: MOCK_ROOT.toLowerCase(), agentId: MOCK_MANAGER.toLowerCase() },
      {
        model: "claude-sonnet-5",
        inputTokens: 500,
        outputTokens: 100,
        usdMicros: 2_000,
        priceSource: "provider",
        tokensEstimated: false,
      },
    );

    const report = await h.pnl.report({ crewId: MOCK_MANAGER, from: FROM, to: TO });
    assert.equal(report.totals.inference.usdMicros, 2_000);
    const manager = report.seats.find((s) => s.agentId === MOCK_MANAGER.toLowerCase())!;
    assert.equal(manager.inference.usdMicros, 2_000);
    // Nothing is double-counted, so the seat rows still reconcile.
    assert.equal(report.unattributed.inference.calls, 0);
  });

  it("says the window is partial when only the in-process ring can answer", async () => {
    const h = harness();
    seedTrail(h.runtime);
    const report = await h.pnl.report({
      crewId: MOCK_MANAGER,
      from: FROM,
      to: TO,
    });
    assert.equal(report.sources.onchain.store, "memory");
    assert.equal(report.sources.onchain.complete, false);
    assert.equal(report.sources.inference.available, true);
    assert.ok(report.notes.some((n) => n.includes("bounded ring")));
  });

  it("reports model cost as unmeasured, not zero, with no meter wired", async () => {
    const runtime = new CrewRuntime({
      client: createLacrewClient({ useMock: true }),
    });
    const pnl = createPnl({ runtime, now: () => new Date(AT) });
    const report = await pnl.report({
      crewId: MOCK_MANAGER,
      from: FROM,
      to: TO,
    });
    assert.equal(report.sources.inference.available, false);
    assert.equal(report.totals.inference.calls, 0);
    assert.ok(report.notes.some((n) => n.includes("not configured")));
  });

  it("prices connector calls only where the operator's table does", async () => {
    const priced = harness({ connectorPrices: { "github.merge_pr": 0.02 } });
    seedTrail(priced.runtime);
    const withPrices = await priced.pnl.report({
      crewId: MOCK_MANAGER,
      from: FROM,
      to: TO,
    });
    assert.equal(withPrices.totals.connectors.usdMicros, 20_000);
    assert.equal(withPrices.totals.connectors.unpricedCalls, 1);

    const bare = harness();
    seedTrail(bare.runtime);
    const noPrices = await bare.pnl.report({
      crewId: MOCK_MANAGER,
      from: FROM,
      to: TO,
    });
    assert.equal(noPrices.totals.connectors.usdMicros, null);
    assert.ok(noPrices.notes.some((n) => n.includes("price unknown")));
  });

  it("refuses a report on the bucket that belongs to nobody", async () => {
    const h = harness();
    await assert.rejects(
      () => h.pnl.report({ crewId: "unattributed", from: FROM, to: TO }),
      /unattributed_has_no_pnl/,
    );
  });

  it("refuses a seat that does not report to this crew", async () => {
    const h = harness();
    await assert.rejects(
      () =>
        h.pnl.report({
          crewId: MOCK_MANAGER,
          agentId: MOCK_ROOT,
          from: FROM,
          to: TO,
        }),
      /agent_not_in_crew/,
    );
  });

  it("narrows to one seat when asked", async () => {
    const h = harness();
    seedTrail(h.runtime);
    const report = await h.pnl.report({
      crewId: MOCK_MANAGER,
      agentId: MOCK_WORKER,
      from: FROM,
      to: TO,
    });
    assert.equal(report.scope.kind, "agent");
    assert.equal(report.seats.length, 0);
    assert.equal(report.totals.onchain.assets.find((a) => a.asset === "USDC")!.spent, "50000000");
  });
});

describe("GET /pnl", () => {
  it("serves the report, and the same figures as CSV", async () => {
    const h = harness();
    seedTrail(h.runtime);
    const res = await h.app.request(`/pnl?crewId=${MOCK_MANAGER}&from=${FROM}&to=${TO}`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      totals: { onchain: { assets: Array<{ asset: string; spent: string }> } };
      period: { from: string; to: string };
      mode: string;
    };
    assert.equal(body.period.from, FROM);
    assert.equal(body.totals.onchain.assets[0]!.spent, "50000000");

    const csv = await h.app.request(`/pnl?crewId=${MOCK_MANAGER}&from=${FROM}&to=${TO}&format=csv`);
    assert.equal(csv.status, 200);
    assert.match(csv.headers.get("content-type") ?? "", /text\/csv/);
    const text = await csv.text();
    assert.ok(text.includes("onchain_spent,USDC,50000000"));
  });

  it("400s a window it cannot measure and 404s a foreign seat", async () => {
    const h = harness();
    const bad = await h.app.request(`/pnl?crewId=${MOCK_MANAGER}&from=nonsense`);
    assert.equal(bad.status, 400);
    assert.equal(((await bad.json()) as { error: string }).error, "invalid_from");

    const missing = await h.app.request("/pnl");
    assert.equal(missing.status, 400);

    const foreign = await h.app.request(
      `/pnl?crewId=${MOCK_MANAGER}&agentId=${MOCK_ROOT}&from=${FROM}&to=${TO}`,
    );
    assert.equal(foreign.status, 404);
  });

  it("503s when no P&L surface is wired rather than answering with zeros", async () => {
    const runtime = new CrewRuntime({
      client: createLacrewClient({ useMock: true }),
    });
    const app = createOrchestratorApp({
      runtime,
      queue: new InMemoryQueue(),
      model: new MemoryModelProvider(),
      flows: undefined as never,
      mcpUseMock: true,
      isDbReady: () => false,
      isDbConfigured: () => false,
    });
    const res = await app.request(`/pnl?crewId=${MOCK_MANAGER}`);
    assert.equal(res.status, 503);
  });
});

describe("connector price table from the environment", () => {
  it("reads nothing by default — no vendor ships pre-priced", () => {
    assert.equal(connectorPricesFromEnv({}), null);
    assert.deepEqual(connectorPricesFromEnv({ LACREW_CONNECTOR_PRICES: '{"github":0.001}' }), {
      github: 0.001,
    });
  });
});
