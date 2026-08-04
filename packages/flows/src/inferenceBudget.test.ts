import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_MODEL_PRICES,
  INFERENCE_BUDGET_WARN_RATIO,
  ZERO_USAGE,
  addUsage,
  budgetAlertCrossing,
  budgetPeriod,
  budgetScopeKey,
  budgetStatus,
  estimateTokens,
  limitDimensions,
  lookupModelPrice,
  normalizeInferenceBudget,
  parseModelPrices,
  priceCompletion,
  validateInferenceBudget,
  type InferenceBudget,
} from "./inferenceBudget.js";

const base = (over: Partial<InferenceBudget> = {}): InferenceBudget =>
  normalizeInferenceBudget({
    crewId: "Trading",
    limits: { maxUsd: 100 },
    enabled: true,
    ...over,
  });

describe("inference budget shape", () => {
  it("lowercases the crew and agent, and defaults to a soft monthly budget", () => {
    const budget = base({ agentId: "0xAABBCCDDEEFF00112233445566778899AaBbCcDd" });
    assert.equal(budget.crewId, "trading");
    assert.equal(budget.agentId, "0xaabbccddeeff00112233445566778899aabbccdd");
    assert.equal(budget.period, "calendar_month");
    assert.equal(budget.policy, "soft");
    // The narrower blast radius is the default: stop the timer, not the crew.
    assert.equal(budget.pauseHeartbeatOnBreach, true);
  });

  it("refuses an enabled budget that bounds nothing", () => {
    assert.throws(
      () => normalizeInferenceBudget({ crewId: "trading", limits: {}, enabled: true }),
      /at least one of maxUsd/,
    );
    // Disabled is a half-filled form, not a dangerous config.
    const draft = normalizeInferenceBudget({ crewId: "trading", limits: {} });
    assert.equal(draft.enabled, false);
  });

  it("refuses limits that are not positive, and token limits that are fractional", () => {
    const negative = validateInferenceBudget({ ...base(), limits: { maxUsd: -1 } });
    assert.equal(negative.ok, false);
    const fractional = validateInferenceBudget({
      ...base(),
      limits: { maxInputTokens: 10.5 },
    });
    assert.equal(fractional.ok, false);
  });

  it("refuses a bad agent address, period, policy and window", () => {
    assert.equal(validateInferenceBudget({ ...base(), agentId: "0xnope" }).ok, false);
    assert.equal(validateInferenceBudget({ ...base(), period: "yearly" as never }).ok, false);
    assert.equal(validateInferenceBudget({ ...base(), policy: "warn" as never }).ok, false);
    assert.equal(validateInferenceBudget({ ...base(), period: "window", windowDays: 0 }).ok, false);
    assert.equal(
      validateInferenceBudget({ ...base(), period: "window", windowDays: 365 }).ok,
      false,
    );
  });

  it("nests an agent scope under its crew so the two rows read as related", () => {
    assert.equal(budgetScopeKey({ crewId: "Trading" }), "crew:trading");
    assert.equal(budgetScopeKey({ crewId: "Trading", agentId: "0xAB" }), "crew:trading/agent:0xab");
  });

  it("reports only the dimensions actually bounded", () => {
    assert.deepEqual(limitDimensions({ maxUsd: 1, maxOutputTokens: 2 }), ["usd", "outputTokens"]);
    assert.deepEqual(limitDimensions({}), []);
  });
});

describe("budget periods", () => {
  it("keys a calendar month in UTC and rolls at the boundary", () => {
    const budget = base();
    const july = budgetPeriod(budget, new Date("2026-07-30T23:59:59Z"));
    const august = budgetPeriod(budget, new Date("2026-08-01T00:00:00Z"));
    assert.equal(july.key, "2026-07");
    assert.equal(july.endsAt, "2026-08-01T00:00:00.000Z");
    assert.equal(august.key, "2026-08");
    assert.notEqual(july.key, august.key);
  });

  it("tiles a fixed window from its anchor, so both replicas agree", () => {
    const budget = base({
      period: "window",
      windowDays: 7,
      anchorAt: "2026-01-01T00:00:00.000Z",
    });
    const first = budgetPeriod(budget, new Date("2026-01-03T12:00:00Z"));
    const second = budgetPeriod(budget, new Date("2026-01-08T00:00:00Z"));
    assert.equal(first.startsAt, "2026-01-01T00:00:00.000Z");
    assert.equal(first.endsAt, "2026-01-08T00:00:00.000Z");
    assert.equal(second.startsAt, "2026-01-08T00:00:00.000Z");
    assert.notEqual(first.key, second.key);
  });

  it("keys an epoch period by its configured length", () => {
    const budget = base({
      period: "epoch",
      epochSeconds: 86_400,
      anchorAt: "2026-01-01T00:00:00.000Z",
    });
    const day = budgetPeriod(budget, new Date("2026-01-11T06:00:00Z"));
    assert.equal(day.key, "epoch:86400000:10");
    assert.equal(day.startsAt, "2026-01-11T00:00:00.000Z");
  });
});

describe("budget status", () => {
  it("warns at the 80% line and reads exceeded at the line itself", () => {
    const limits = { maxUsd: 100 };
    const ok = budgetStatus(limits, { ...ZERO_USAGE, usdMicros: 50_000_000 });
    assert.equal(ok.state, "ok");

    const warn = budgetStatus(limits, {
      ...ZERO_USAGE,
      usdMicros: INFERENCE_BUDGET_WARN_RATIO * 100 * 1_000_000,
    });
    assert.equal(warn.state, "warning");
    assert.equal(warn.worst, "usd");

    const over = budgetStatus(limits, { ...ZERO_USAGE, usdMicros: 100_000_000 });
    assert.equal(over.state, "exceeded");
    assert.equal(over.remaining.usd, 0);
  });

  it("takes the worst of several bounded dimensions", () => {
    const status = budgetStatus(
      { maxUsd: 100, maxOutputTokens: 1_000 },
      { ...ZERO_USAGE, usdMicros: 10_000_000, outputTokens: 900 },
    );
    assert.equal(status.worst, "outputTokens");
    assert.equal(status.state, "warning");
    assert.equal(status.remaining.inputTokens, undefined);
  });

  it("is ok with no limits at all rather than dividing by zero", () => {
    const status = budgetStatus({}, { ...ZERO_USAGE, usdMicros: 999_000_000 });
    assert.equal(status.state, "ok");
    assert.equal(status.ratio, 0);
    assert.equal(status.worst, null);
  });

  it("flags a dollar figure that omits unpriced calls", () => {
    const status = budgetStatus(
      { maxUsd: 10 },
      { ...ZERO_USAGE, calls: 3, unpricedCalls: 1, usdMicros: 1_000_000 },
    );
    assert.equal(status.usdIncomplete, true);
    // A token-only budget makes no dollar claim, so there is nothing to qualify.
    assert.equal(
      budgetStatus({ maxInputTokens: 5 }, { ...ZERO_USAGE, unpricedCalls: 1 }).usdIncomplete,
      false,
    );
  });

  it("alerts once per crossing, not on every call above the line", () => {
    assert.equal(budgetAlertCrossing("ok", "warning"), "warning");
    assert.equal(budgetAlertCrossing("warning", "warning"), null);
    assert.equal(budgetAlertCrossing("warning", "exceeded"), "exceeded");
    // A raised cap drops the state back; that is not an alert either.
    assert.equal(budgetAlertCrossing("exceeded", "ok"), null);
  });
});

describe("pricing", () => {
  it("matches by longest prefix, ignoring a router prefix and a date stamp", () => {
    assert.deepEqual(
      lookupModelPrice("anthropic/claude-sonnet-5-20260101"),
      DEFAULT_MODEL_PRICES["claude-sonnet"],
    );
    assert.deepEqual(lookupModelPrice("gpt-4o-mini"), DEFAULT_MODEL_PRICES["gpt-4o-mini"]);
    assert.equal(lookupModelPrice("some-local-llama"), null);
  });

  it("prefers the price the provider actually reported", () => {
    const priced = priceCompletion({
      model: "claude-sonnet-5",
      usage: { promptTokens: 1_000, completionTokens: 100 },
      usd: 0.25,
    });
    assert.equal(priced.priceSource, "provider");
    assert.equal(priced.usdMicros, 250_000);
    assert.equal(priced.tokensEstimated, false);
  });

  it("prices from the table in exact micro-dollars", () => {
    const priced = priceCompletion({
      model: "gpt-4o-mini",
      usage: { promptTokens: 1_000_000, completionTokens: 1_000_000 },
    });
    assert.equal(priced.priceSource, "table");
    // $0.15 + $0.60 for a million tokens each.
    assert.equal(priced.usdMicros, 750_000);
  });

  it("counts an unknown model as unpriced, never as free", () => {
    const priced = priceCompletion({
      model: "some-local-llama",
      usage: { promptTokens: 10, completionTokens: 10 },
    });
    assert.equal(priced.usdMicros, null);
    assert.equal(priced.priceSource, "none");

    const folded = addUsage(ZERO_USAGE, priced);
    assert.equal(folded.calls, 1);
    assert.equal(folded.unpricedCalls, 1);
    assert.equal(folded.usdMicros, 0);
    // Tokens still count, so a token ceiling still bounds an unpriced model.
    assert.equal(folded.inputTokens, 10);
  });

  it("falls back to approximate tokens when the provider reports none", () => {
    const priced = priceCompletion({
      model: "gpt-4o",
      promptText: "12345678",
      completionText: "1234",
    });
    assert.equal(priced.tokensEstimated, true);
    assert.equal(priced.inputTokens, 2);
    assert.equal(priced.outputTokens, 1);
    assert.equal(estimateTokens(undefined), 0);
  });

  it("honours a whole override table, or none of it", () => {
    assert.deepEqual(parseModelPrices('{"mine":{"inputPerMTok":1,"outputPerMTok":2}}'), {
      mine: { inputPerMTok: 1, outputPerMTok: 2 },
    });
    // One malformed entry falls the whole table back to the shipped defaults,
    // rather than enforcing a number nobody wrote.
    assert.equal(parseModelPrices('{"mine":{"inputPerMTok":"free"}}'), null);
    assert.equal(parseModelPrices('{"mine":{"inputPerMTok":-1,"outputPerMTok":2}}'), null);
    assert.equal(parseModelPrices("not json"), null);
    assert.equal(parseModelPrices(undefined), null);
  });
});
