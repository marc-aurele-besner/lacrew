import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  PLAN_REQUIRED_DEFAULT_MIN_CHARS,
  PLAN_REQUIRED_DEFAULT_WINDOW_MS,
  classifyPlanEffect,
  normalizePlanRequiredRule,
  planRequiredFor,
  planThreadIds,
  qualifyingPlan,
  resolvePlanRequired,
  type PlanMessage,
  type PlanRequiredRule,
} from "./planRequired.js";

const WORKER = "0xWORKER";
const NOW = new Date("2026-07-31T12:00:00.000Z");

const plan = (over: Partial<PlanMessage> = {}): PlanMessage => ({
  id: "msg_1",
  threadId: `agent:${WORKER.toLowerCase()}`,
  at: NOW.toISOString(),
  author: WORKER.toLowerCase(),
  authorKind: "agent",
  kind: "plan",
  body: "Rebalancing the desk: sell 200 USDC of WETH, then post the fill.",
  ...over,
});

const check = (over: Partial<Parameters<typeof qualifyingPlan>[1]> = {}) => ({
  principal: WORKER,
  threadIds: planThreadIds(WORKER),
  now: NOW,
  windowMs: PLAN_REQUIRED_DEFAULT_WINDOW_MS,
  minPlanChars: PLAN_REQUIRED_DEFAULT_MIN_CHARS,
  ...over,
});

describe("plan-required rules", () => {
  it("fills the defaults and refuses a window that bounds nothing", () => {
    const rule = normalizePlanRequiredRule(
      { scope: { level: "workspace" }, mode: "side_effects" },
      NOW.toISOString(),
    );
    assert.equal(rule.windowMs, PLAN_REQUIRED_DEFAULT_WINDOW_MS);
    assert.equal(rule.minPlanChars, PLAN_REQUIRED_DEFAULT_MIN_CHARS);
    assert.equal(rule.acceptUpstreamPlan, false);

    assert.throws(
      () =>
        normalizePlanRequiredRule(
          { scope: { level: "workspace" }, mode: "side_effects", windowMs: 7 * 24 * 3_600_000 },
          NOW.toISOString(),
        ),
      /windowMs/,
    );
    assert.throws(
      () =>
        normalizePlanRequiredRule(
          { scope: { level: "workspace" }, mode: "always" as never },
          NOW.toISOString(),
        ),
      /mode must be/,
    );
  });

  it("resolves narrowest-first: agent beats crew beats workspace", () => {
    const rules: PlanRequiredRule[] = [
      { scope: { level: "workspace" }, mode: "spends_only" },
      { scope: { level: "crew", ref: "0xMANAGER" }, mode: "side_effects" },
      { scope: { level: "agent", ref: WORKER }, mode: "off" },
    ];
    assert.equal(
      resolvePlanRequired(rules, { principal: WORKER, managers: ["0xMANAGER"] }).mode,
      "off",
    );
    assert.equal(
      resolvePlanRequired(rules, { principal: "0xOTHER", managers: ["0xMANAGER"] }).mode,
      "side_effects",
    );
    assert.equal(resolvePlanRequired(rules, { principal: "0xLONER" }).mode, "spends_only");
    // Nothing configured is `off`, and says so.
    assert.deepEqual(resolvePlanRequired([], { principal: WORKER }).source, { kind: "default" });
  });

  it("takes the nearest manager when two crews above the seat both have rules", () => {
    const rules: PlanRequiredRule[] = [
      { scope: { level: "crew", ref: "0xDIVISION" }, mode: "off" },
      { scope: { level: "crew", ref: "0xDESK" }, mode: "side_effects" },
    ];
    // `managers` arrives nearest-first, as ancestorsOf walks upward.
    const resolved = resolvePlanRequired(rules, {
      principal: WORKER,
      managers: ["0xDESK", "0xDIVISION"],
    });
    assert.equal(resolved.mode, "side_effects");
  });
});

describe("what a mode covers", () => {
  it("classifies the money path, the mutators and the operator's own surfaces", () => {
    assert.equal(classifyPlanEffect("lacrew_propose_intent"), "spend");
    assert.equal(classifyPlanEffect("lacrew_org_action"), "write");
    assert.equal(classifyPlanEffect("lacrew_set_budget"), "write");
    assert.equal(classifyPlanEffect("lacrew_governance"), "write");
    // Reads and the conversation itself change nothing that needs planning —
    // in particular `lacrew_say`, which is how the plan gets posted.
    assert.equal(classifyPlanEffect("lacrew_get_org_tree"), null);
    assert.equal(classifyPlanEffect("lacrew_read_thread"), null);
    assert.equal(classifyPlanEffect("lacrew_say"), null);
    assert.equal(classifyPlanEffect("lacrew_approve_intent"), null);
  });

  it("treats an unclassifiable external surface as a write", () => {
    assert.equal(classifyPlanEffect("github.merge_pr"), "write");
    assert.equal(classifyPlanEffect("mcp__gh__create_issue"), "write");
    // With a registry to ask, a read is a read.
    const effectOf = (tool: string): "read" | "write" =>
      tool === "github.list_prs" ? "read" : "write";
    assert.equal(classifyPlanEffect("github.list_prs", effectOf), null);
    assert.equal(classifyPlanEffect("github.merge_pr", effectOf), "write");
    // A registered route can never reclassify the money path.
    assert.equal(
      classifyPlanEffect("lacrew_propose_intent", () => "read"),
      "spend",
    );
  });

  it("spends_only covers the propose and nothing else", () => {
    assert.equal(planRequiredFor("off", "spend"), false);
    assert.equal(planRequiredFor("spends_only", "spend"), true);
    assert.equal(planRequiredFor("spends_only", "write"), false);
    assert.equal(planRequiredFor("side_effects", "spend"), true);
    assert.equal(planRequiredFor("side_effects", "write"), true);
  });
});

describe("what counts as a plan", () => {
  it("takes the newest fresh plan by this principal", () => {
    const found = qualifyingPlan(
      [
        plan({ id: "old", body: "An earlier plan that is long enough to count." }),
        plan({ id: "new" }),
      ],
      check(),
    );
    assert.equal(found.plan?.id, "new");
  });

  it("refuses another seat's plan, a human's, and a note", () => {
    const cases: PlanMessage[] = [
      plan({ author: "0xOTHER" }),
      plan({ authorKind: "human", author: "alice" }),
      plan({ kind: "note" }),
      plan({ threadId: "crew:someone-elses-desk" }),
      plan({ body: "on it" }),
    ];
    for (const message of cases) {
      const found = qualifyingPlan([message], check());
      assert.equal(found.plan, null, `${message.kind}/${message.author} should not qualify`);
    }
  });

  it("says stale rather than missing when the only plan is outside the window", () => {
    const old = plan({ at: new Date(NOW.getTime() - 6 * 3_600_000).toISOString() });
    const found = qualifyingPlan([old], check());
    assert.equal(found.plan, null);
    assert.equal("miss" in found && found.miss, "stale");
    const empty = qualifyingPlan([], check());
    assert.equal("miss" in empty && empty.miss, "none");
  });

  it("accepts an old plan the same run emitted", () => {
    const old = plan({
      at: new Date(NOW.getTime() - 6 * 3_600_000).toISOString(),
      refs: [{ kind: "flowRun", id: "run-42" }],
    });
    assert.equal(qualifyingPlan([old], check({ runId: "run-42" })).plan?.id, "msg_1");
    // A different run's plan is just an old plan.
    assert.equal(qualifyingPlan([old], check({ runId: "run-43" })).plan, null);
  });

  it("counts a manager's plan only when upstream plans are accepted", () => {
    const managers = plan({ author: "0xmanager", threadId: "crew:0xmanager" });
    const subject = check({ threadIds: planThreadIds(WORKER, ["0xMANAGER"]) });
    assert.equal(qualifyingPlan([managers], subject).plan, null);
    assert.equal(
      qualifyingPlan([managers], { ...subject, upstream: ["0xMANAGER"] }).plan?.id,
      "msg_1",
    );
  });

  it("keeps the plan a run started with while that run waits", () => {
    // The shape of a pipeline that parked on an ask-mode write or a human gate:
    // planned, started, waited an hour for a person, resumed. Ageing the plan
    // out here would refuse the very step the person just approved.
    const at = new Date(NOW.getTime() - 65 * 60_000);
    const planned = plan({ at: at.toISOString() });
    const runStartedAt = new Date(at.getTime() + 60_000);

    assert.equal(qualifyingPlan([planned], check()).plan, null);
    assert.equal(qualifyingPlan([planned], check({ runStartedAt })).plan?.id, "msg_1");
    // Still bounded: a plan that was already stale when the run began does not
    // become current by being carried into it.
    const older = plan({ at: new Date(runStartedAt.getTime() - 90 * 60_000).toISOString() });
    assert.equal(qualifyingPlan([older], check({ runStartedAt })).plan, null);
  });

  it("an unparseable timestamp is stale, never fresh", () => {
    const broken = plan({ at: "whenever" });
    const found = qualifyingPlan([broken], check());
    assert.equal(found.plan, null);
    assert.equal("miss" in found && found.miss, "stale");
  });
});
