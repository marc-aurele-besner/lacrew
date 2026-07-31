/**
 * The plan-required surface (F2.31): rules, the checker, and what it does when
 * it cannot answer.
 *
 * The pure qualification rules are covered in `@lacrew/flows`; what is tested
 * here is the part that needs a process — the stored rules, the live
 * conversation read, the same-run exception, delegation, and the deliberate
 * decision to fail *open*.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ProtocolEvent } from "@lacrew/core";
import type { Message } from "./conversation.js";
import {
  createPlanRequirements,
  isPlanRequired,
  planRequiredFromEnv,
  type PlanRequiredStore,
} from "./planRequired.js";
import type { PlanRequiredRecord } from "@lacrew/flows";

const WORKER = "0xworker";
const MANAGER = "0xmanager";
const BODY = "Rebalancing the desk: sell 200 USDC of WETH, then report the fill in-thread.";

const message = (over: Partial<Message> = {}): Message => ({
  id: "msg_1",
  threadId: `agent:${WORKER}`,
  at: new Date().toISOString(),
  author: WORKER,
  authorKind: "agent",
  kind: "plan",
  body: BODY,
  ...over,
});

function surfaceWith(messages: Message[], opts: { store?: PlanRequiredStore } = {}) {
  const events: ProtocolEvent[] = [];
  const surface = createPlanRequirements({
    ...(opts.store ? { store: opts.store } : {}),
    messagesIn: (threadId) => messages.filter((m) => m.threadId === threadId),
    onEvent: (event) => events.push(event),
  });
  return { surface, events };
}

describe("plan-required surface", () => {
  it("passes a call the mode does not cover, and names the mode it read", async () => {
    const { surface } = surfaceWith([]);
    await surface.set({ scope: { level: "workspace" }, mode: "spends_only" });
    const outcome = await surface.check({ tool: "github.merge_pr", principal: WORKER });
    assert.deepEqual(outcome, { required: false, effect: "write", mode: "spends_only" });
  });

  it("refuses a spend with no plan, and says what to do about it", async () => {
    const { surface, events } = surfaceWith([]);
    await surface.set({ scope: { level: "workspace" }, mode: "spends_only" });
    await assert.rejects(
      () => surface.check({ tool: "lacrew_propose_intent", principal: WORKER }),
      (err: unknown) => {
        assert.ok(isPlanRequired(err));
        assert.equal(err.effect, "spend");
        assert.equal(err.miss, "none");
        // The instruction rides on the message, so it reaches the step trace
        // and the model that has to try again.
        assert.match(err.message, /Post a `plan` message/);
        assert.match(err.message, /approves nothing/);
        return true;
      },
    );
    assert.equal(events.filter((e) => e.type === "PlanRequiredBlocked").length, 1);
  });

  it("accepts a plan this run already emitted, however old it is", async () => {
    const old = message({
      at: new Date(Date.now() - 6 * 3_600_000).toISOString(),
      refs: [{ kind: "flowRun", id: "run-42" }],
    });
    const { surface } = surfaceWith([old]);
    await surface.set({ scope: { level: "workspace" }, mode: "side_effects" });

    const outcome = await surface.check({
      tool: "github.merge_pr",
      principal: WORKER,
      runId: "run-42",
    });
    assert.equal(outcome.required, true);
    assert.equal(outcome.required && outcome.plan.id, "msg_1");

    // Another run's plan is just an old plan.
    await assert.rejects(
      () => surface.check({ tool: "github.merge_pr", principal: WORKER, runId: "run-43" }),
      (err: unknown) => isPlanRequired(err) && err.miss === "stale",
    );
  });

  it("makes the delegate plan, unless the rule accepts the manager's", async () => {
    const managerPlan = message({ author: MANAGER, threadId: `crew:${MANAGER}` });
    const { surface } = surfaceWith([managerPlan]);
    const call = {
      tool: "github.merge_pr",
      principal: WORKER,
      managers: [MANAGER],
      upstream: [MANAGER],
    };

    await surface.set({ scope: { level: "workspace" }, mode: "side_effects" });
    await assert.rejects(() => surface.check(call), isPlanRequired);

    await surface.set({
      scope: { level: "workspace" },
      mode: "side_effects",
      acceptUpstreamPlan: true,
    });
    const outcome = await surface.check(call);
    assert.equal(outcome.required, true);
  });

  it("reads a plan from the crew thread the seat reports into", async () => {
    const inCrew = message({ threadId: `crew:${MANAGER}` });
    const { surface } = surfaceWith([inCrew]);
    await surface.set({ scope: { level: "workspace" }, mode: "side_effects" });
    const outcome = await surface.check({
      tool: "github.merge_pr",
      principal: WORKER,
      managers: [MANAGER],
    });
    assert.equal(outcome.required, true);
  });

  it("takes a read classification from the registry and gates nothing", async () => {
    const { surface, events } = surfaceWith([]);
    await surface.set({ scope: { level: "workspace" }, mode: "side_effects" });
    const outcome = await surface.check({
      tool: "github.list_prs",
      principal: WORKER,
      effectOf: () => "read",
    });
    assert.equal(outcome.required, false);
    assert.equal(events.length, 0, "a read that was never gated leaves no refusal row");
  });

  it("writes rules through to the store and reads them back", async () => {
    const rows = new Map<string, PlanRequiredRecord>();
    const store: PlanRequiredStore = {
      loadPlanRequirements: async () => [...rows.values()],
      savePlanRequirement: async (record) => {
        rows.set(
          record.scope.level === "workspace" ? "workspace" : `${record.scope.level}:${record.scope.ref}`,
          record,
        );
      },
      removePlanRequirement: async (key) => {
        rows.delete(key);
      },
    };
    const { surface } = surfaceWith([], { store });
    await surface.set({ scope: { level: "crew", ref: MANAGER }, mode: "side_effects" });
    assert.equal(rows.size, 1);

    const restarted = surfaceWith([], { store });
    assert.equal(await restarted.surface.hydrate(), 1);
    assert.equal(
      restarted.surface.resolve({ principal: WORKER, managers: [MANAGER] }).mode,
      "side_effects",
    );

    await surface.clear({ level: "crew", ref: MANAGER });
    assert.equal(rows.size, 0);
  });

  it("propagates its own failures rather than reporting a plan it never read", async () => {
    const surface = createPlanRequirements({
      messagesIn: () => {
        throw new Error("thread unreadable");
      },
    });
    await surface.set({ scope: { level: "workspace" }, mode: "side_effects" });
    // Not a PlanRequiredError: the caller decides what this means, and for this
    // control the answer is to log it and let the call proceed — every onchain
    // and connector bound is still in front of it.
    await assert.rejects(
      () => surface.check({ tool: "github.merge_pr", principal: WORKER }),
      (err: unknown) => !isPlanRequired(err),
    );
  });
});

describe("plan-required from the environment", () => {
  it("defaults to off and refuses a mode nobody defined", () => {
    assert.equal(planRequiredFromEnv({}), null);
    assert.equal(planRequiredFromEnv({ LACREW_PLAN_REQUIRED: "off" }), null);
    assert.throws(() => planRequiredFromEnv({ LACREW_PLAN_REQUIRED: "always" }), /expected off/);
  });

  it("carries the window and the handoff switch", () => {
    const rule = planRequiredFromEnv({
      LACREW_PLAN_REQUIRED: "side_effects",
      LACREW_PLAN_REQUIRED_WINDOW_MIN: "15",
      LACREW_PLAN_REQUIRED_UPSTREAM: "1",
    });
    assert.deepEqual(rule, {
      scope: { level: "workspace" },
      mode: "side_effects",
      windowMs: 15 * 60_000,
      acceptUpstreamPlan: true,
    });
  });
});
