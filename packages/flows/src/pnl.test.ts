import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  PNL_MAX_RANGE_DAYS,
  buildPnlReport,
  lookupConnectorPrice,
  parseConnectorPrices,
  pnlToCsv,
  resolvePnlPeriod,
  type PnlAuditEvent,
  type PnlBuildInput,
  type PnlSources,
} from "./pnl.js";

const CREW = "0x1111111111111111111111111111111111111111";
const SEAT_A = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const SEAT_B = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const TARGET = "0xcccccccccccccccccccccccccccccccccccccccc";

const complete = (store: string): PnlSources["onchain"] => ({
  available: true,
  complete: true,
  store,
});

const sources = (over: Partial<PnlSources> = {}): PnlSources => ({
  onchain: complete("postgres"),
  inference: complete("postgres"),
  connectors: complete("postgres"),
  ...over,
});

const period = resolvePnlPeriod(
  { from: "2026-07-01T00:00:00.000Z", to: "2026-08-01T00:00:00.000Z" },
  new Date("2026-07-15T00:00:00.000Z"),
);

const build = (over: Partial<PnlBuildInput> = {}) =>
  buildPnlReport({
    scope: { crewId: CREW },
    period,
    asOf: "2026-07-15T12:00:00.000Z",
    seats: [
      { account: CREW, label: "Desk manager" },
      { account: SEAT_A, label: "Researcher" },
      { account: SEAT_B, label: "Trader" },
    ],
    events: [],
    usage: [],
    sources: sources(),
    ...over,
  });

describe("period resolution", () => {
  it("takes an explicit range verbatim and marks it custom", () => {
    const p = resolvePnlPeriod(
      { from: "2026-07-01T00:00:00.000Z", to: "2026-07-08T00:00:00.000Z" },
      new Date("2026-07-31T00:00:00.000Z"),
    );
    assert.equal(p.kind, "custom");
    assert.equal(p.from, "2026-07-01T00:00:00.000Z");
    assert.equal(p.to, "2026-07-08T00:00:00.000Z");
    assert.equal(p.timezone, "UTC");
  });

  it("resolves the calendar month, week and epoch the report is labelled with", () => {
    const now = new Date("2026-07-31T18:00:00.000Z"); // a Friday
    const month = resolvePnlPeriod({ period: "calendar_month" }, now);
    assert.equal(month.key, "2026-07");
    assert.equal(month.from, "2026-07-01T00:00:00.000Z");
    assert.equal(month.to, "2026-08-01T00:00:00.000Z");

    const week = resolvePnlPeriod({ period: "calendar_week" }, now);
    assert.equal(week.from, "2026-07-27T00:00:00.000Z"); // Monday
    assert.equal(week.to, "2026-08-03T00:00:00.000Z");
    assert.match(week.key, /^2026-W\d\d$/);

    const epoch = resolvePnlPeriod(
      {
        period: "epoch",
        epochSeconds: 604_800,
        epochAnchorAt: "2026-07-01T00:00:00.000Z",
      },
      now,
    );
    assert.equal(epoch.from, "2026-07-29T00:00:00.000Z");
    assert.equal(epoch.to, "2026-08-05T00:00:00.000Z");
  });

  it("refuses a range it cannot measure rather than falling back to this month", () => {
    const now = new Date("2026-07-15T00:00:00.000Z");
    assert.throws(
      () => resolvePnlPeriod({ from: "not-a-date" }, now),
      /invalid_from/,
    );
    assert.throws(
      () =>
        resolvePnlPeriod(
          { from: "2026-07-02T00:00:00Z", to: "2026-07-01T00:00:00Z" },
          now,
        ),
      /empty_period/,
    );
    assert.throws(
      () =>
        resolvePnlPeriod(
          { from: "2020-01-01T00:00:00Z", to: "2026-01-01T00:00:00Z" },
          now,
        ),
      /period_too_long/,
    );
    assert.throws(
      () => resolvePnlPeriod({ period: "yearly" }, now),
      /invalid_period/,
    );
    assert.ok(PNL_MAX_RANGE_DAYS >= 365);
  });
});

describe("onchain lines", () => {
  const events: PnlAuditEvent[] = [
    // One settled spend announced twice — locally at propose, then from the receipt.
    {
      type: "AllowanceSpent",
      at: "2026-07-02T10:00:00.000Z",
      payload: {
        agent: SEAT_A,
        target: TARGET,
        value: "50000000",
        txHash: "0xdead",
      },
    },
    {
      type: "ActionExecuted",
      at: "2026-07-02T10:00:03.000Z",
      payload: {
        agent: SEAT_A,
        target: TARGET,
        value: "50000000",
        txHash: "0xdead",
        callOk: true,
      },
    },
    // An escalation that was decided inside the window is not pending.
    {
      type: "IntentCreated",
      at: "2026-07-03T10:00:00.000Z",
      payload: {
        intentId: "7",
        agent: SEAT_B,
        target: TARGET,
        value: "75000000",
      },
    },
    {
      type: "IntentResolved",
      at: "2026-07-03T11:00:00.000Z",
      payload: { intentId: "7" },
    },
    // One that was not.
    {
      type: "IntentCreated",
      at: "2026-07-04T10:00:00.000Z",
      payload: {
        intentId: "8",
        agent: SEAT_B,
        target: TARGET,
        value: "120000000",
      },
    },
    {
      type: "AllowanceStreamed",
      at: "2026-07-01T00:00:10.000Z",
      payload: {
        node: SEAT_A,
        amount: "200000000",
        epoch: 12,
        txHash: "0xbeef",
      },
    },
    // The schedule tick itself moves nothing and is not a ledger line.
    {
      type: "AllowanceStreamed",
      at: "2026-07-01T00:00:00.000Z",
      payload: { epoch: 12 },
    },
    // Another workspace's seat, on a shared trail.
    {
      type: "AllowanceSpent",
      at: "2026-07-05T10:00:00.000Z",
      payload: {
        agent: TARGET,
        target: TARGET,
        value: "999000000",
        txHash: "0xfeed",
      },
    },
    // Outside the window.
    {
      type: "AllowanceSpent",
      at: "2026-06-30T23:59:59.000Z",
      payload: {
        agent: SEAT_A,
        target: TARGET,
        value: "1000000",
        txHash: "0xold",
      },
    },
  ];

  it("counts a spend once, keeps pending separate, and ignores rows outside the crew", () => {
    const report = build({ events });
    const usdc = report.totals.onchain.assets.find((a) => a.asset === "USDC")!;
    assert.equal(usdc.spent, "50000000");
    assert.equal(usdc.pending, "120000000");
    assert.equal(usdc.granted, "200000000");
    assert.equal(report.totals.onchain.counts.spends, 1);
    assert.equal(report.totals.onchain.counts.pending, 1);
    assert.equal(report.totals.onchain.counts.grants, 1);
  });

  it("reconciles the seat table with the crew header", () => {
    const report = build({ events });
    const seatA = report.seats.find((s) => s.agentId === SEAT_A)!;
    const seatB = report.seats.find((s) => s.agentId === SEAT_B)!;
    assert.equal(
      seatA.onchain.assets.find((a) => a.asset === "USDC")!.spent,
      "50000000",
    );
    assert.equal(
      seatB.onchain.assets.find((a) => a.asset === "USDC")!.pending,
      "120000000",
    );
    const seatSpend = report.seats.reduce(
      (sum, s) =>
        sum +
        BigInt(s.onchain.assets.find((a) => a.asset === "USDC")?.spent ?? "0"),
      0n,
    );
    assert.equal(
      seatSpend.toString(),
      report.totals.onchain.assets.find((a) => a.asset === "USDC")!.spent,
    );
  });

  it("keeps a marketplace purchase out of the spend line it shares a tx with", () => {
    const report = build({
      events: [
        {
          type: "MarketplacePurchase",
          at: "2026-07-06T10:00:00.000Z",
          payload: {
            agent: SEAT_A,
            buyer: SEAT_A,
            catalogId: "flow-42",
            gross: "10000000",
            fee: "500000",
            verdict: "ALLOW",
            txHash: "0xmarket",
          },
        },
        {
          type: "ActionExecuted",
          at: "2026-07-06T10:00:02.000Z",
          payload: {
            agent: SEAT_A,
            target: TARGET,
            value: "10000000",
            txHash: "0xmarket",
          },
        },
      ],
    });
    const usdc = report.totals.onchain.assets.find((a) => a.asset === "USDC")!;
    assert.equal(usdc.marketplace, "10000000");
    assert.equal(usdc.spent, "0");
    assert.equal(report.totals.onchain.counts.spends, 0);
  });

  it("groups by the asset a payload names instead of assuming the primary one", () => {
    const report = build({
      events: [
        {
          type: "AllowanceSpent",
          at: "2026-07-02T10:00:00.000Z",
          payload: {
            agent: SEAT_A,
            target: TARGET,
            value: "1000000000000000000",
            asset: "WETH",
            txHash: "0x1",
          },
        },
      ],
    });
    assert.deepEqual(
      report.totals.onchain.assets.map((a) => a.asset),
      ["WETH"],
    );
  });
});

describe("inference lines", () => {
  const usage = [
    {
      scopeKey: `crew:${CREW}`,
      model: "claude-sonnet-5",
      inputTokens: 1_000,
      outputTokens: 200,
      usdMicros: 4_500,
      priceSource: "provider",
      flowId: "daily-brief",
      at: "2026-07-02T09:00:00.000Z",
    },
    {
      scopeKey: `crew:${CREW}/agent:${SEAT_A}`,
      model: "claude-sonnet-5",
      inputTokens: 1_000,
      outputTokens: 200,
      usdMicros: 4_500,
      priceSource: "provider",
      flowId: "daily-brief",
      at: "2026-07-02T09:00:00.000Z",
    },
    // A call nobody could price: counted, never summed as zero.
    {
      scopeKey: `crew:${CREW}`,
      model: "some-local-model",
      inputTokens: 500,
      outputTokens: 100,
      usdMicros: null,
      priceSource: "none",
      at: "2026-07-03T09:00:00.000Z",
    },
  ];

  it("reads the crew total from the crew key, never by summing seat rows twice", () => {
    const report = build({ usage });
    assert.equal(report.totals.inference.calls, 2);
    assert.equal(report.totals.inference.usdMicros, 4_500);
    assert.equal(report.totals.inference.unpricedCalls, 1);
    const seatA = report.seats.find((s) => s.agentId === SEAT_A)!;
    assert.equal(seatA.inference.calls, 1);
    assert.equal(seatA.inference.usdMicros, 4_500);
  });

  it("names the difference between the crew and its seats instead of hiding it", () => {
    const report = build({ usage });
    assert.equal(report.unattributed.inference.calls, 1);
    assert.equal(report.unattributed.inference.usdMicros, 0);
    assert.ok(report.notes.some((n) => n.includes("without naming a seat")));
    assert.ok(report.notes.some((n) => n.includes("floor")));
  });

  it("ranks the flows behind the number", () => {
    const report = build({ usage });
    assert.equal(report.totals.inference.byFlow[0]!.key, "daily-brief");
    assert.equal(report.totals.inference.byModel[0]!.key, "claude-sonnet-5");
  });
});

describe("connector lines", () => {
  const events: PnlAuditEvent[] = [
    {
      type: "ToolCalled",
      at: "2026-07-02T09:00:00.000Z",
      payload: {
        connector: "github",
        route: "merge_pr",
        effect: "write",
        ok: true,
        crewId: CREW,
        agentId: SEAT_A,
      },
    },
    {
      type: "ToolCalled",
      at: "2026-07-02T09:05:00.000Z",
      payload: {
        connector: "github",
        route: "list_prs",
        effect: "read",
        ok: false,
        crewId: CREW,
      },
    },
    {
      type: "ToolCalled",
      at: "2026-07-02T09:06:00.000Z",
      payload: {
        connector: "github",
        route: "merge_pr",
        effect: "write",
        ok: true,
        crewId: "other",
      },
    },
  ];

  it("counts reads and writes for this crew only", () => {
    const report = build({ events });
    assert.equal(report.totals.connectors.calls, 2);
    assert.equal(report.totals.connectors.writes, 1);
    assert.equal(report.totals.connectors.reads, 1);
    assert.equal(report.totals.connectors.failed, 1);
  });

  it("says price unknown rather than $0 when no table prices the route", () => {
    const report = build({ events });
    assert.equal(report.totals.connectors.usdMicros, null);
    assert.equal(report.totals.connectors.unpricedCalls, 2);
    assert.ok(report.notes.some((n) => n.includes("price unknown")));
  });

  it("prices what the table covers and reports the rest as unpriced", () => {
    const report = build({
      events,
      connectorPrices: { "github.merge_pr": 0.01 },
    });
    assert.equal(report.totals.connectors.usdMicros, 10_000);
    assert.equal(report.totals.connectors.pricedCalls, 1);
    assert.equal(report.totals.connectors.unpricedCalls, 1);
  });
});

describe("price table", () => {
  it("prefers the route over the connector and drops nonsense entries", () => {
    const prices = parseConnectorPrices(
      '{"github":0.001,"github.merge_pr":0.01,"bad":-3}',
    )!;
    assert.equal(lookupConnectorPrice(prices, "github", "merge_pr"), 0.01);
    assert.equal(lookupConnectorPrice(prices, "github", "list_prs"), 0.001);
    assert.equal(lookupConnectorPrice(prices, "bad", "x"), null);
    assert.equal(lookupConnectorPrice(prices, "slack", "post"), null);
    assert.equal(parseConnectorPrices("not json"), null);
    assert.equal(parseConnectorPrices(undefined), null);
  });
});

describe("honesty flags", () => {
  it("distinguishes an unconfigured meter from a measured zero", () => {
    const report = build({
      sources: sources({
        inference: { available: false, complete: false, store: "none" },
      }),
    });
    assert.equal(report.totals.inference.calls, 0);
    assert.ok(report.notes.some((n) => n.includes("not configured")));
  });

  it("flags a window answered from a bounded ring", () => {
    const report = build({
      sources: sources({
        onchain: { available: true, complete: false, store: "memory" },
      }),
    });
    assert.ok(report.notes.some((n) => n.includes("bounded ring")));
  });

  it("says so when the inference budget runs on a different window than the report", () => {
    const report = build({
      budget: {
        scopeKey: `crew:${CREW}`,
        periodKey: "2026-07",
        periodFrom: "2026-07-01T00:00:00.000Z",
        periodTo: "2026-08-01T00:00:00.000Z",
        policy: "hard",
        limitUsd: 100,
        status: {
          state: "ok",
          ratio: 0.1,
          worst: "usd",
          usage: {
            inputTokens: 0,
            outputTokens: 0,
            usdMicros: 10_000_000,
            calls: 3,
            unpricedCalls: 0,
          },
          limits: { maxUsd: 100 },
          remaining: { usd: 90 },
          usdIncomplete: false,
        },
      },
    });
    assert.equal(report.headroom.inference!.periodMatchesReport, true);
    assert.equal(report.headroom.inference!.remainingUsdMicros, 90_000_000);

    const drifted = build({
      period: resolvePnlPeriod(
        { from: "2026-07-01T00:00:00.000Z", to: "2026-07-08T00:00:00.000Z" },
        new Date("2026-07-05T00:00:00.000Z"),
      ),
      budget: {
        scopeKey: `crew:${CREW}`,
        periodKey: "2026-07",
        periodFrom: "2026-07-01T00:00:00.000Z",
        periodTo: "2026-08-01T00:00:00.000Z",
        policy: "soft",
        status: {
          state: "ok",
          ratio: 0,
          worst: null,
          usage: {
            inputTokens: 0,
            outputTokens: 0,
            usdMicros: 0,
            calls: 0,
            unpricedCalls: 0,
          },
          limits: {},
          remaining: {},
          usdIncomplete: false,
        },
      },
    });
    assert.equal(drifted.headroom.inference!.periodMatchesReport, false);
    assert.equal(drifted.headroom.inference!.limitUsdMicros, null);
    assert.ok(drifted.notes.some((n) => n.includes("different window")));
  });

  it("carries allowance headroom only for the seats in scope", () => {
    const report = build({
      allowances: [
        { node: SEAT_A, asset: "USDC", balance: "150000000", cap: "50000000" },
        { node: TARGET, asset: "USDC", balance: "999000000", cap: null },
      ],
    });
    assert.deepEqual(
      report.headroom.onchain.map((h) => h.node),
      [SEAT_A],
    );
  });
});

describe("agent scope", () => {
  it("reports one seat, with no roster table under it", () => {
    const report = build({
      scope: { crewId: CREW, agentId: SEAT_A },
      events: [
        {
          type: "AllowanceSpent",
          at: "2026-07-02T10:00:00.000Z",
          payload: {
            agent: SEAT_A,
            target: TARGET,
            value: "50000000",
            txHash: "0x1",
          },
        },
        {
          type: "AllowanceSpent",
          at: "2026-07-02T10:00:00.000Z",
          payload: {
            agent: SEAT_B,
            target: TARGET,
            value: "70000000",
            txHash: "0x2",
          },
        },
      ],
    });
    assert.equal(report.scope.kind, "agent");
    assert.equal(report.seats.length, 0);
    assert.equal(
      report.totals.onchain.assets.find((a) => a.asset === "USDC")!.spent,
      "50000000",
    );
  });
});

describe("csv export", () => {
  it("leaves the $ cell empty when nothing priced the row, and says which", () => {
    const report = build({
      events: [
        {
          type: "ToolCalled",
          at: "2026-07-02T09:00:00.000Z",
          payload: {
            connector: "github",
            route: "merge_pr",
            effect: "write",
            ok: true,
            crewId: CREW,
          },
        },
      ],
    });
    const csv = pnlToCsv(report);
    const header = csv.split("\n").find((l) => l.startsWith("scope,"))!;
    assert.equal(
      header,
      "scope,seat,meter,unit,quantity,usd,price_known,detail",
    );
    const connectorRow = csv
      .split("\n")
      .find((l) => l.includes(",connectors,"))!;
    assert.match(connectorRow, /,connectors,calls,1,,no,/);
    assert.ok(csv.includes("# lacrew P&L"));
    assert.ok(csv.includes("asOf 2026-07-15T12:00:00.000Z"));
  });
});
