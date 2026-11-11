import { describe, it } from "node:test";
import assert from "node:assert/strict";

import * as epochStreamer from "./epochStreamer.js";
import * as escalationRouter from "./escalationRouter.js";
import * as orgRegistry from "./orgRegistry.js";
import { NodeKind } from "./orgRegistry.js";
import * as policies from "./policies.js";
import { Verdict } from "./policies.js";
import * as sessionRegistry from "./sessionRegistry.js";
import { SCOPE_ALL, SCOPE_PROPOSE_INTENT, SCOPE_SPEND_WHITELIST } from "./sessionRegistry.js";
import {
  KEY,
  MANAGER,
  OTHER_TARGET,
  ROOT,
  SECOND_HUMAN,
  STRANGER,
  Sim,
  TARGET,
  USDC,
  WORKER,
  bootstrapOrg,
  crewOrg,
} from "./testkit.test.js";
import * as token from "./token.js";
import { MAX_UINT256, ONE_DAY, SimRevert, ZERO_ADDRESS, type Address, type Hex } from "./types.js";
import { allocateAddress, inertEnv, type Ctx, type World } from "./world.js";

const HOUR = 3_600n;

/** Propose as the agent itself: no session narrows the call. */
const propose =
  (value: bigint, target: Address = TARGET, data: Hex = "0x", agent: Address = WORKER) =>
  (ctx: Ctx) =>
    escalationRouter.propose(ctx, agent, target, value, data);

const allowanceOf = (sim: Sim, node: Address) => sim.world.treasury.allowanceBalance[node] ?? 0n;
const balanceOf = (sim: Sim, account: Address) => sim.read((ctx) => token.balanceOf(ctx, account));
const intent = (sim: Sim, id: bigint) => sim.read((ctx) => escalationRouter.intents(ctx, id));

describe("kernel EscalationRouter: propose", () => {
  it("allows an in-cap spend to a whitelisted target and settles it", () => {
    const sim = crewOrg();
    const mark = sim.events.length;
    const out = sim.send(WORKER, propose(40n * USDC));
    assert.deepEqual(out, { intentId: 0n, verdict: Verdict.ALLOW });
    assert.equal(allowanceOf(sim, WORKER), 160n * USDC);
    assert.equal(balanceOf(sim, TARGET), 40n * USDC);
    assert.deepEqual(sim.eventNames(mark), ["Transfer", "AllowanceSpent", "ActionExecuted"]);
    assert.deepEqual(sim.lastEvent("ActionExecuted").args, {
      agent: WORKER,
      target: TARGET,
      value: 40n * USDC,
      callOk: true,
    });
    assert.equal(sim.world.escalationRouter.nextIntentId, 1n);
  });

  it("escalates an over-cap spend to the agent's parent without moving funds", () => {
    const sim = crewOrg();
    const out = sim.send(WORKER, propose(75n * USDC));
    assert.deepEqual(out, { intentId: 1n, verdict: Verdict.ESCALATE });
    assert.deepEqual(intent(sim, 1n), {
      agent: WORKER,
      target: TARGET,
      value: 75n * USDC,
      data: "0x",
      awaitingApprover: MANAGER,
      resolved: false,
      approved: false,
    });
    assert.equal(allowanceOf(sim, WORKER), 200n * USDC);
    assert.deepEqual(sim.lastEvent("IntentCreated").args, {
      intentId: 1n,
      agent: WORKER,
      awaitingApprover: MANAGER,
    });
  });

  it("reverts on a DENY verdict", () => {
    const sim = crewOrg();
    const err = sim.reverts("UnexpectedVerdict", WORKER, propose(1n, OTHER_TARGET));
    assert.deepEqual(err.args, { verdict: Verdict.DENY });
  });

  it("reverts when the allowance cannot cover an allowed spend", () => {
    const sim = crewOrg();
    sim.send(ROOT, (ctx) =>
      policies.setAgentCap(ctx, sim.world.addresses.spendCapPolicy, WORKER, 1_000n * USDC),
    );
    const err = sim.reverts("InsufficientAllowance", WORKER, propose(201n * USDC));
    assert.deepEqual(err.args, { node: WORKER, requested: 201n * USDC, available: 200n * USDC });
  });

  it("refuses an agent that is unknown or inactive", () => {
    const sim = crewOrg();
    sim.reverts("NodeNotFound", STRANGER, propose(1n, TARGET, "0x", STRANGER));
    sim.send(ROOT, (ctx) => orgRegistry.setActive(ctx, WORKER, false));
    sim.reverts("InactiveAgent", WORKER, propose(1n));
  });

  it("refuses the contracts that trust the router, even when whitelisted", () => {
    const sim = crewOrg();
    const a = sim.world.addresses;
    const perNode = sim.send(ROOT, (ctx) => {
      const address = allocateAddress(ctx);
      policies.deployRateLimitPolicy(ctx, address, 5n, HOUR);
      return address;
    });
    sim.send(ROOT, (ctx) => escalationRouter.setNodeRateRecorder(ctx, WORKER, perNode));
    for (const target of [
      a.escalationRouter,
      a.treasury,
      a.sessionRegistry,
      a.rateLimitPolicy,
      perNode,
    ]) {
      sim.send(ROOT, (ctx) => policies.setAllowed(ctx, a.whitelistPolicy, target, true));
      sim.reverts("ProtectedTarget", WORKER, propose(0n, target));
    }
    // Another node's recorder is not protected for this agent.
    sim.send(ROOT, (ctx) => escalationRouter.setNodeRateRecorder(ctx, WORKER, ZERO_ADDRESS));
    sim.send(WORKER, propose(0n, perNode));
    // A zero target matches no unwired slot; it is the whitelist that denies it.
    sim.reverts("UnexpectedVerdict", WORKER, propose(0n, ZERO_ADDRESS));
  });

  it("the root has no approver to escalate to", () => {
    const sim = crewOrg();
    sim.send(ROOT, (ctx) =>
      policies.setAgentCap(ctx, sim.world.addresses.spendCapPolicy, ROOT, 10n),
    );
    const err = sim.reverts("NoApprover", ROOT, propose(11n, TARGET, "0x", ROOT));
    assert.deepEqual(err.args, { agent: ROOT });
  });

  it("a zero-value allowed action touches no funds", () => {
    const sim = crewOrg();
    const mark = sim.events.length;
    sim.send(WORKER, propose(0n));
    assert.deepEqual(sim.eventNames(mark), ["ActionExecuted"]);
  });

  it("calls the target with the intent's calldata and reports whether it succeeded", () => {
    const sim = crewOrg();
    const seen: Array<{ sender: Address; target: Address; data: Hex }> = [];
    sim.env = {
      ...inertEnv,
      dispatch(ctx, target, data) {
        seen.push({ sender: ctx.sender, target, data });
        if (data === "0xdead") {
          // Writes made by a call that then reverts must not survive it.
          (ctx.world as World).treasury.totalReserved = 0n;
          throw new SimRevert("Nope");
        }
      },
    };
    sim.send(WORKER, propose(10n * USDC, TARGET, "0x1234"));
    assert.deepEqual(seen, [
      { sender: sim.world.addresses.escalationRouter, target: TARGET, data: "0x1234" },
    ]);
    assert.equal(sim.lastEvent("ActionExecuted").args.callOk, true);

    sim.send(WORKER, propose(10n * USDC, TARGET, "0xdead"));
    assert.equal(sim.lastEvent("ActionExecuted").args.callOk, false);
    // The spend stands: only the failed call's own frame was rolled back.
    assert.equal(allowanceOf(sim, WORKER), 180n * USDC);
    assert.equal(sim.world.treasury.totalReserved, 180n * USDC);
  });
});

describe("kernel EscalationRouter: policy rate limit", () => {
  it("escalates once the window is full and allows again after it rolls over", () => {
    const sim = crewOrg({ rateLimit: { maxActions: 2n, windowSeconds: HOUR } });
    assert.equal(sim.send(WORKER, propose(1n)).verdict, Verdict.ALLOW);
    assert.equal(sim.send(WORKER, propose(1n)).verdict, Verdict.ALLOW);
    const third = sim.send(WORKER, propose(1n));
    assert.deepEqual(third, { intentId: 1n, verdict: Verdict.ESCALATE });
    sim.warp(HOUR);
    assert.equal(sim.send(WORKER, propose(1n)).verdict, Verdict.ALLOW);
  });

  it("counts a created intent as an action", () => {
    const sim = crewOrg({ rateLimit: { maxActions: 2n, windowSeconds: HOUR } });
    sim.send(WORKER, propose(75n * USDC));
    sim.send(WORKER, propose(75n * USDC));
    const rl = sim.world.policies[sim.world.addresses.rateLimitPolicy];
    assert.deepEqual((rl as policies.RateLimitPolicyState).windows[WORKER], {
      windowStart: sim.now,
      count: 2n,
    });
  });

  it("records into a node's own recorder when one is bound", () => {
    const sim = crewOrg();
    const own = sim.send(ROOT, (ctx) => {
      const address = allocateAddress(ctx);
      policies.deployRateLimitPolicy(ctx, address, 1n, HOUR);
      policies.setRecorder(ctx, address, ctx.world.addresses.escalationRouter);
      return address;
    });
    const stack = sim.send(ROOT, (ctx) => {
      const address = allocateAddress(ctx);
      policies.deployPolicyStack(ctx, address, [ctx.world.addresses.whitelistPolicy, own]);
      return address;
    });
    sim.send(ROOT, (ctx) => escalationRouter.setNodePolicy(ctx, WORKER, stack));
    sim.send(ROOT, (ctx) => escalationRouter.setNodeRateRecorder(ctx, WORKER, own));

    assert.equal(sim.send(WORKER, propose(1n)).verdict, Verdict.ALLOW);
    assert.equal(sim.send(WORKER, propose(1n)).verdict, Verdict.ESCALATE);
    const global = sim.world.policies[sim.world.addresses.rateLimitPolicy];
    assert.deepEqual((global as policies.RateLimitPolicyState).windows, {});
  });
});

describe("kernel EscalationRouter: sessions", () => {
  const issue = (
    sim: Sim,
    over: Partial<{
      mask: bigint;
      maxValue: bigint;
      targets: Address[];
      window: [bigint, bigint];
      rate: [bigint, bigint];
      ttl: bigint;
    }> = {},
  ) =>
    sim.send(ROOT, (ctx) =>
      sessionRegistry.issueScopedTimed(
        ctx,
        WORKER,
        KEY,
        ctx.now + (over.ttl ?? ONE_DAY),
        over.mask ?? SCOPE_ALL,
        over.maxValue ?? MAX_UINT256,
        over.targets ?? [],
        over.window?.[0] ?? 0n,
        over.window?.[1] ?? 0n,
        over.rate?.[0] ?? 0n,
        over.rate?.[1] ?? 0n,
      ),
    );

  it("requires a valid session key from anyone but the agent itself", () => {
    const sim = crewOrg();
    const err = sim.reverts("InvalidSession", KEY, propose(1n));
    assert.deepEqual(err.args, { agent: WORKER, key: KEY });
    issue(sim);
    assert.equal(sim.send(KEY, propose(1n)).verdict, Verdict.ALLOW);
    sim.reverts("InvalidSession", STRANGER, propose(1n));
  });

  it("rejects an expired or revoked key", () => {
    const sim = crewOrg();
    const id = issue(sim, { ttl: HOUR });
    sim.warp(HOUR);
    sim.reverts("InvalidSession", KEY, propose(1n));
    issue(sim);
    sim.send(ROOT, (ctx) => sessionRegistry.revoke(ctx, id + 1n));
    sim.reverts("InvalidSession", KEY, propose(1n));
  });

  it("a key without the propose scope cannot propose", () => {
    const sim = crewOrg();
    issue(sim, { mask: SCOPE_SPEND_WHITELIST });
    const err = sim.reverts("SessionScopeDenied", KEY, propose(1n));
    assert.deepEqual(err.args, {
      agent: WORKER,
      required: SCOPE_PROPOSE_INTENT,
      granted: SCOPE_SPEND_WHITELIST,
    });
  });

  it("a propose-only key can raise an intent but cannot settle an ALLOW", () => {
    const sim = crewOrg();
    issue(sim, { mask: SCOPE_PROPOSE_INTENT });
    const err = sim.reverts("SessionScopeDenied", KEY, propose(1n));
    assert.deepEqual(err.args, {
      agent: WORKER,
      required: SCOPE_SPEND_WHITELIST,
      granted: SCOPE_PROPOSE_INTENT,
    });
    assert.equal(sim.send(KEY, propose(75n * USDC)).verdict, Verdict.ESCALATE);
  });

  it("enforces the key's max value, pinned targets and daily window", () => {
    const sim = crewOrg();
    sim.send(ROOT, (ctx) =>
      policies.setAllowed(ctx, sim.world.addresses.whitelistPolicy, OTHER_TARGET, true),
    );
    // T0 is 80 000 seconds into its day.
    issue(sim, { maxValue: 5n, targets: [TARGET], window: [80_000n, 80_100n] });
    const value = sim.reverts("SessionValueExceeded", KEY, propose(6n));
    assert.deepEqual(value.args, { agent: WORKER, value: 6n, maxValue: 5n });
    const target = sim.reverts("SessionTargetDenied", KEY, propose(5n, OTHER_TARGET));
    assert.deepEqual(target.args, { agent: WORKER, target: OTHER_TARGET, allowedTarget: TARGET });
    sim.send(KEY, propose(5n));
    sim.warp(100n);
    sim.reverts("SessionTimeWindowDenied", KEY, propose(5n));
    // The agent's own propose is not narrowed by any key.
    sim.send(WORKER, propose(6n, OTHER_TARGET));
  });

  it("charges the key's rate limit per propose and refuses past it", () => {
    const sim = crewOrg();
    issue(sim, { rate: [2n, HOUR] });
    sim.send(KEY, propose(1n));
    sim.send(KEY, propose(75n * USDC));
    sim.reverts("RateLimitExceeded", KEY, propose(1n));
    // A propose that reverts for another reason is not charged.
    sim.warp(HOUR);
    sim.reverts("UnexpectedVerdict", KEY, propose(1n, OTHER_TARGET));
    sim.send(KEY, propose(1n));
    sim.send(KEY, propose(1n));
    sim.reverts("RateLimitExceeded", KEY, propose(1n));
  });

  it("with no session registry wired, anyone may propose for an agent", () => {
    const sim = crewOrg();
    sim.send(ROOT, (ctx) => escalationRouter.setSessionRegistry(ctx, ZERO_ADDRESS));
    assert.equal(sim.send(STRANGER, propose(1n)).verdict, Verdict.ALLOW);
  });
});

describe("kernel EscalationRouter: resolve", () => {
  function pending(value: bigint): Sim {
    const sim = crewOrg();
    sim.send(WORKER, propose(value));
    return sim;
  }
  const resolve = (id: bigint, approved: boolean) => (ctx: Ctx) =>
    escalationRouter.resolve(ctx, id, approved);

  it("the manager finalizes an intent within its own cap", () => {
    const sim = pending(75n * USDC);
    const mark = sim.events.length;
    sim.send(MANAGER, resolve(1n, true));
    assert.equal(intent(sim, 1n).resolved, true);
    assert.equal(intent(sim, 1n).approved, true);
    // The spend is the proposing agent's, not the approver's.
    assert.equal(allowanceOf(sim, WORKER), 125n * USDC);
    assert.equal(balanceOf(sim, TARGET), 75n * USDC);
    assert.deepEqual(sim.eventNames(mark), [
      "Transfer",
      "AllowanceSpent",
      "ActionExecuted",
      "IntentResolved",
    ]);
    assert.deepEqual(sim.lastEvent("IntentResolved").args, { intentId: 1n, approved: true });
  });

  it("climbs to the root when the manager's own policy escalates", () => {
    const sim = crewOrg();
    secondEpoch(sim);
    sim.send(WORKER, propose(250n * USDC));
    sim.send(MANAGER, resolve(1n, true));
    assert.equal(intent(sim, 1n).resolved, false);
    assert.equal(intent(sim, 1n).awaitingApprover, ROOT);
    assert.deepEqual(sim.lastEvent("IntentEscalated").args, {
      intentId: 1n,
      from: MANAGER,
      to: ROOT,
    });
    sim.reverts("NotAwaitingApprover", MANAGER, resolve(1n, true));

    sim.send(ROOT, resolve(1n, true));
    assert.equal(intent(sim, 1n).approved, true);
    assert.equal(allowanceOf(sim, WORKER), 150n * USDC);
  });

  it("the root finalizes even when its own policy would escalate", () => {
    const sim = crewOrg();
    secondEpoch(sim);
    sim.send(ROOT, (ctx) =>
      policies.setAgentCap(ctx, sim.world.addresses.spendCapPolicy, ROOT, 1n),
    );
    sim.send(WORKER, propose(250n * USDC));
    sim.send(MANAGER, resolve(1n, true));
    sim.send(ROOT, resolve(1n, true));
    assert.equal(intent(sim, 1n).approved, true);
  });

  it("a HumanRoot node below the root finalizes instead of climbing", () => {
    const sim = bootstrapOrg();
    const a = sim.world.addresses;
    sim.send(ROOT, (ctx) => orgRegistry.addNode(ctx, SECOND_HUMAN, NodeKind.HumanRoot, ROOT));
    sim.send(ROOT, (ctx) => orgRegistry.addNode(ctx, WORKER, NodeKind.WorkerAgent, SECOND_HUMAN));
    sim.send(ROOT, (ctx) => policies.setAllowed(ctx, a.whitelistPolicy, TARGET, true));
    sim.send(WORKER, propose(75n * USDC));
    assert.equal(intent(sim, 1n).awaitingApprover, SECOND_HUMAN);
    // No allowance was streamed, so finalizing reaches the treasury and fails there:
    // the human's approval was terminal.
    sim.reverts("InsufficientAllowance", SECOND_HUMAN, resolve(1n, true));
  });

  it("rejection closes the intent without moving funds", () => {
    const sim = pending(75n * USDC);
    sim.send(MANAGER, resolve(1n, false));
    assert.equal(intent(sim, 1n).resolved, true);
    assert.equal(intent(sim, 1n).approved, false);
    assert.equal(allowanceOf(sim, WORKER), 200n * USDC);
    assert.deepEqual(sim.lastEvent("IntentResolved").args, { intentId: 1n, approved: false });
    sim.reverts("IntentAlreadyResolved", MANAGER, resolve(1n, true));
  });

  it("an approval the approver's policy denies closes the intent as rejected", () => {
    const sim = pending(75n * USDC);
    sim.send(ROOT, (ctx) =>
      policies.setAllowed(ctx, sim.world.addresses.whitelistPolicy, TARGET, false),
    );
    sim.send(MANAGER, resolve(1n, true));
    assert.equal(intent(sim, 1n).resolved, true);
    assert.equal(intent(sim, 1n).approved, false);
    assert.equal(allowanceOf(sim, WORKER), 200n * USDC);
  });

  it("only the awaiting approver may resolve, and only an intent that exists", () => {
    const sim = pending(75n * USDC);
    sim.reverts("IntentNotFound", MANAGER, resolve(2n, true));
    sim.reverts("IntentNotFound", MANAGER, resolve(0n, true));
    sim.reverts("NotAwaitingApprover", STRANGER, resolve(1n, true));
    sim.reverts("NotAwaitingApprover", ROOT, resolve(1n, false));
    sim.reverts("NotAwaitingApprover", WORKER, resolve(1n, true));
  });

  it("an approval reverts when the agent's allowance no longer covers the spend", () => {
    const sim = pending(75n * USDC);
    sim.send(ROOT, (ctx) =>
      policies.setAgentCap(ctx, sim.world.addresses.spendCapPolicy, WORKER, 1_000n * USDC),
    );
    sim.send(WORKER, propose(150n * USDC));
    sim.reverts("InsufficientAllowance", MANAGER, resolve(1n, true));
    assert.equal(intent(sim, 1n).resolved, false);
  });

  it("a deactivated approver resolves nothing until it is active again", () => {
    const sim = pending(75n * USDC);
    sim.send(ROOT, (ctx) => orgRegistry.setActive(ctx, MANAGER, false));
    const err = sim.reverts("InactiveApprover", MANAGER, resolve(1n, true));
    assert.deepEqual(err.args, { approver: MANAGER });
    sim.reverts("InactiveApprover", MANAGER, resolve(1n, false));
    sim.send(ROOT, (ctx) => orgRegistry.setActive(ctx, MANAGER, true));
    sim.send(MANAGER, resolve(1n, true));
    assert.equal(intent(sim, 1n).approved, true);
  });

  it("the root resolves in place of a deactivated or removed approver, and nobody else", () => {
    const sim = crewOrg();
    secondEpoch(sim);
    sim.send(WORKER, propose(75n * USDC));
    sim.send(WORKER, propose(250n * USDC));
    sim.send(ROOT, (ctx) => orgRegistry.setActive(ctx, MANAGER, false));
    sim.reverts("NotAwaitingApprover", STRANGER, resolve(1n, true));
    sim.reverts("NotAwaitingApprover", WORKER, resolve(1n, false));
    sim.send(ROOT, resolve(1n, true));
    assert.equal(intent(sim, 1n).approved, true);
    assert.equal(balanceOf(sim, TARGET), 75n * USDC);

    sim.send(ROOT, (ctx) => orgRegistry.removeNode(ctx, MANAGER));
    sim.reverts("InactiveApprover", MANAGER, resolve(2n, true));
    sim.reverts("InactiveApprover", MANAGER, resolve(2n, false));
    sim.send(ROOT, resolve(2n, true));
    assert.equal(intent(sim, 2n).approved, true);
    assert.equal(balanceOf(sim, TARGET), 325n * USDC);
  });

  it("an intent whose agent is deactivated or removed can be rejected but not approved", () => {
    const sim = pending(75n * USDC);
    sim.send(WORKER, propose(80n * USDC));
    sim.send(ROOT, (ctx) => orgRegistry.setActive(ctx, WORKER, false));
    const err = sim.reverts("InactiveAgent", MANAGER, resolve(1n, true));
    assert.deepEqual(err.args, { agent: WORKER });
    assert.equal(allowanceOf(sim, WORKER), 200n * USDC);
    sim.send(MANAGER, resolve(1n, false));
    assert.equal(intent(sim, 1n).resolved, true);
    assert.equal(intent(sim, 1n).approved, false);

    sim.send(ROOT, (ctx) => orgRegistry.removeNode(ctx, WORKER));
    sim.reverts("InactiveAgent", MANAGER, resolve(2n, true));
    sim.send(MANAGER, resolve(2n, false));
    assert.equal(balanceOf(sim, TARGET), 0n);
  });
});

/** Run a second epoch so the worker holds enough for a 250-unit intent. */
function secondEpoch(sim: Sim): void {
  sim.send(ROOT, (ctx) => epochStreamer.runNextEpoch(ctx));
}

describe("kernel EscalationRouter: wiring", () => {
  it("is wired by its deployer until a governor is bound, then by the governor alone", () => {
    const sim = bootstrapOrg();
    const governor = sim.world.addresses.governanceModule;
    const setters: Array<(ctx: Ctx) => void> = [
      (ctx) => escalationRouter.setTreasury(ctx, TARGET),
      (ctx) => escalationRouter.setRateRecorder(ctx, TARGET),
      (ctx) => escalationRouter.setSessionRegistry(ctx, TARGET),
      (ctx) => escalationRouter.setNodePolicy(ctx, WORKER, TARGET),
      (ctx) => escalationRouter.setNodeRateRecorder(ctx, WORKER, TARGET),
      (ctx) => escalationRouter.setGovernor(ctx, governor),
    ];
    for (const set of setters) sim.reverts("NotAuthorized", STRANGER, set);
    sim.reverts("ZeroAddress", ROOT, (ctx) =>
      escalationRouter.setNodePolicy(ctx, ZERO_ADDRESS, TARGET),
    );
    sim.reverts("ZeroAddress", ROOT, (ctx) =>
      escalationRouter.setNodeRateRecorder(ctx, ZERO_ADDRESS, TARGET),
    );
    // The zero check on setGovernor comes before the caller check.
    sim.reverts("ZeroAddress", STRANGER, (ctx) => escalationRouter.setGovernor(ctx, ZERO_ADDRESS));

    sim.send(ROOT, (ctx) => escalationRouter.setGovernor(ctx, governor));
    for (const set of setters) sim.reverts("NotAuthorized", ROOT, set);
    sim.send(governor, (ctx) => escalationRouter.setNodePolicy(ctx, WORKER, TARGET));
    assert.equal(sim.world.escalationRouter.policyOf[WORKER], TARGET);
    assert.deepEqual(sim.lastEvent("NodePolicyUpdated").args, {
      node: WORKER,
      policyModule: TARGET,
    });
  });

  it("reverts without an error when its policy is not a module", () => {
    const sim = crewOrg();
    sim.send(ROOT, (ctx) => escalationRouter.setNodePolicy(ctx, WORKER, STRANGER));
    sim.reverts("EvmRevert", WORKER, propose(1n));
  });
});
