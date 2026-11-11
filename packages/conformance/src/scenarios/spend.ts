/**
 * The spend path: propose, the three verdicts, escalation up the tree, and
 * what the router refuses before policy is even asked.
 */

import { HOUR, KIND, USDC, scenario, type Scenario } from "../scenario.js";

const FUNDED = 100_000n * USDC;

export const spendScenarios: Scenario[] = [
  scenario("an in-allowance spend settles at once", (b) => {
    b.crew();
    b.call("worker", "@router", "propose", ["worker", "target", 40n * USDC, "0x"], {
      verdict: "ALLOW",
      events: ["Transfer", "AllowanceSpent", "ActionExecuted"],
    });
    b.expect({
      allowance: { worker: 160n * USDC },
      balance: { target: 40n * USDC },
      treasury: {
        total: FUNDED - 40n * USDC,
        reserved: 160n * USDC,
        liquid: FUNDED - 200n * USDC,
      },
      pending: [],
    });
  }),

  scenario("a spend cap is inclusive, at propose and at approval", (b) => {
    b.crew();
    b.call("root", "@streamer", "runNextEpoch");
    b.allow("worker", "worker", "target", 50n * USDC);
    const justOver = b.escalate("worker", "worker", "target", 50n * USDC + 1n);
    b.resolve("manager", justOver, true, {
      events: ["Transfer", "AllowanceSpent", "ActionExecuted", "IntentResolved"],
    });
    // The manager's cap is 200: exactly that it settles, one unit more it passes up.
    const exact = b.escalate("worker", "worker", "target", 200n * USDC);
    b.resolve("manager", exact, true, {
      events: ["Transfer", "AllowanceSpent", "ActionExecuted", "IntentResolved"],
    });
    const over = b.escalate("worker", "worker", "target", 200n * USDC + 1n);
    b.resolve("manager", over, true, { events: ["IntentEscalated"] });
    b.expect({
      intents: { [exact]: { resolved: true, approved: true }, [over]: { awaiting: "root" } },
      allowance: { worker: 100n * USDC - 1n },
    });
  }),

  scenario("an over-cap spend waits for the manager, who settles it within its own cap", (b) => {
    b.crew();
    const intent = b.escalate("worker", "worker", "target", 75n * USDC);
    b.expect({
      intents: { [intent]: { awaiting: "manager", resolved: false, value: 75n * USDC } },
      pending: [intent],
      allowance: { worker: 200n * USDC },
      balance: { target: 0n },
    });
    b.resolve("manager", intent, true, {
      events: ["Transfer", "AllowanceSpent", "ActionExecuted", "IntentResolved"],
    });
    b.expect({
      intents: { [intent]: { resolved: true, approved: true } },
      pending: [],
      // The spend is the proposing agent's, not the approver's.
      allowance: { worker: 125n * USDC, manager: 0n },
      balance: { target: 75n * USDC },
    });
  }),

  scenario("an escalation climbs to the root when the manager's own policy escalates", (b) => {
    b.crew();
    b.call("root", "@streamer", "runNextEpoch");
    const intent = b.escalate("worker", "worker", "target", 250n * USDC);
    b.resolve("manager", intent, true, { events: ["IntentEscalated"] });
    b.expect({
      intents: { [intent]: { awaiting: "root", resolved: false } },
      pending: [intent],
      allowance: { worker: 400n * USDC },
    });
    b.reverts("NotAwaitingApprover", "manager", "@router", "resolve", [BigInt(intent), true]);
    b.resolve("root", intent, true, {
      events: ["Transfer", "AllowanceSpent", "ActionExecuted", "IntentResolved"],
    });
    b.expect({
      intents: { [intent]: { resolved: true, approved: true } },
      allowance: { worker: 150n * USDC },
      balance: { target: 250n * USDC },
    });
  }),

  scenario("the root finalizes even when its own policy would escalate", (b) => {
    b.crew();
    b.call("root", "@streamer", "runNextEpoch");
    b.call("root", "@spendCap", "setAgentCap", ["root", 1n]);
    const intent = b.escalate("worker", "worker", "target", 250n * USDC);
    b.resolve("manager", intent, true, { events: ["IntentEscalated"] });
    b.resolve("root", intent, true);
    b.expect({ intents: { [intent]: { resolved: true, approved: true } } });
  }),

  scenario("an escalation ends at a HumanRoot node below the root", (b) => {
    b.call("root", "@registry", "addNode", ["human2", KIND.human, "root"]);
    b.call("root", "@registry", "addNode", ["worker2", KIND.worker, "human2"]);
    b.call("root", "@whitelist", "setAllowed", ["target", true]);
    b.fund(1_000n * USDC);
    b.call("root", "@streamer", "setGrant", ["worker2", 200n * USDC]);
    b.call("root", "@streamer", "runNextEpoch");
    const intent = b.escalate("worker2", "worker2", "target", 75n * USDC);
    b.expect({
      intents: { [intent]: { awaiting: "human2" } },
      // The human's own stack would escalate this: its cap is the default 50.
      verdicts: [{ agent: "human2", target: "target", value: 75n * USDC, verdict: "ESCALATE" }],
      nodes: { human2: { kind: "human_root", parent: "root" } },
    });
    b.resolve("human2", intent, true, {
      events: ["Transfer", "AllowanceSpent", "ActionExecuted", "IntentResolved"],
    });
    b.expect({
      intents: { [intent]: { resolved: true, approved: true } },
      allowance: { worker2: 125n * USDC },
    });
  }),

  scenario(
    "a denied target reverts; a rejected or policy-denied approval closes the intent",
    (b) => {
      b.crew();
      b.proposeReverts("UnexpectedVerdict", "worker", "worker", "target2", 1n);

      const rejected = b.escalate("worker", "worker", "target", 75n * USDC);
      b.resolve("manager", rejected, false, { events: ["IntentResolved"] });
      b.expect({
        intents: { [rejected]: { resolved: true, approved: false } },
        allowance: { worker: 200n * USDC },
      });
      b.reverts("IntentAlreadyResolved", "manager", "@router", "resolve", [BigInt(rejected), true]);

      // The approver says yes, but its own policy now denies the target.
      const denied = b.escalate("worker", "worker", "target", 75n * USDC);
      b.call("root", "@whitelist", "setAllowed", ["target", false]);
      b.resolve("manager", denied, true, { events: ["IntentResolved"] });
      b.expect({
        intents: { [denied]: { resolved: true, approved: false } },
        allowance: { worker: 200n * USDC },
        balance: { target: 0n },
        pending: [],
      });
    },
  ),

  scenario("an overdraft reverts in the treasury, at propose and at approval", (b) => {
    b.crew();
    b.call("root", "@spendCap", "setAgentCap", ["worker", 1_000n * USDC]);
    b.proposeReverts(
      "InsufficientAllowance",
      "worker",
      "worker",
      "target",
      201n * USDC,
      "Treasury",
    );

    b.call("root", "@spendCap", "setAgentCap", ["worker", 50n * USDC]);
    const intent = b.escalate("worker", "worker", "target", 75n * USDC);
    b.call("root", "@spendCap", "setAgentCap", ["worker", 1_000n * USDC]);
    b.allow("worker", "worker", "target", 150n * USDC);
    b.reverts(
      "InsufficientAllowance",
      "manager",
      "@router",
      "resolve",
      [BigInt(intent), true],
      "Treasury",
    );
    b.expect({
      intents: { [intent]: { resolved: false, awaiting: "manager" } },
      allowance: { worker: 50n * USDC },
    });
  }),

  scenario("an unknown or inactive agent cannot propose", (b) => {
    b.crew();
    b.proposeReverts("NodeNotFound", "stranger", "stranger", "target", 1n, "OrgRegistry");
    const held = b.escalate("worker", "worker", "target", 75n * USDC);
    b.call("root", "@registry", "setActive", ["worker", false]);
    b.proposeReverts("InactiveAgent", "worker", "worker", "target", 1n);
    b.expect({ nodes: { worker: { active: false } } });
    // Deactivation stops new proposals only: what the agent raised before can still be approved.
    b.resolve("manager", held, true);
    b.expect({
      intents: { [held]: { resolved: true, approved: true } },
      allowance: { worker: 125n * USDC },
    });
    b.call("root", "@registry", "setActive", ["worker", true]);
    b.allow("worker", "worker", "target", 1n);
  }),

  scenario("a deactivated approver still resolves; a removed one cannot climb", (b) => {
    // `resolve` checks the sender against `awaitingApprover` and nothing else.
    b.crew();
    b.call("root", "@streamer", "runNextEpoch");
    const first = b.escalate("worker", "worker", "target", 75n * USDC);
    b.call("root", "@registry", "setActive", ["manager", false]);
    b.resolve("manager", first, true);
    b.expect({ intents: { [first]: { resolved: true, approved: true } } });

    const second = b.escalate("worker", "worker", "target", 250n * USDC);
    b.call("root", "@registry", "removeNode", ["manager"]);
    // Its policy escalates, and escalating reads the approver's own node.
    b.reverts(
      "NodeNotFound",
      "manager",
      "@router",
      "resolve",
      [BigInt(second), true],
      "OrgRegistry",
    );
    b.resolve("manager", second, false);
    b.expect({
      intents: { [second]: { resolved: true, approved: false } },
      nodes: { manager: null, worker: { parent: "root" } },
    });
  }),

  scenario("the contracts that trust the router are refused as targets", (b) => {
    b.crew();
    b.deploy("root", "RateLimitPolicy", "own", [5n, BigInt(HOUR)]);
    b.call("root", "@router", "setNodeRateRecorder", ["worker", "$own"]);
    for (const target of ["@router", "@treasury", "@sessions", "@rateLimit", "$own"]) {
      b.call("root", "@whitelist", "setAllowed", [target, true]);
      b.proposeReverts("ProtectedTarget", "worker", "worker", target, 0n);
    }
    // A recorder is protected only for the node it records.
    b.call("root", "@router", "setNodeRateRecorder", ["worker", "zero"]);
    b.allow("worker", "worker", "$own", 0n);
    // A zero target matches no unwired slot; it is the whitelist that denies it.
    b.proposeReverts("UnexpectedVerdict", "worker", "worker", "zero", 0n);
  }),

  scenario("resolve answers only the awaiting approver, for an intent that exists", (b) => {
    b.crew();
    const intent = b.escalate("worker", "worker", "target", 75n * USDC);
    b.reverts("IntentNotFound", "manager", "@router", "resolve", [BigInt(intent + 1), true]);
    b.reverts("IntentNotFound", "manager", "@router", "resolve", [0n, true]);
    for (const who of ["stranger", "root", "worker"]) {
      b.reverts("NotAwaitingApprover", who, "@router", "resolve", [BigInt(intent), true]);
    }
    b.expect({ pending: [intent] });
  }),

  scenario("the root has nobody to escalate to", (b) => {
    b.crew();
    b.call("root", "@spendCap", "setAgentCap", ["root", 10n]);
    b.proposeReverts("NoApprover", "root", "root", "target", 11n);
    b.allow("root", "root", "target", 0n);
  }),

  scenario("an action's calldata is called on its target, and a failed call is contained", (b) => {
    b.crew();
    // An address with no code accepts any call.
    b.call("worker", "@router", "propose", ["worker", "target", 10n * USDC, "0x1234"], {
      verdict: "ALLOW",
      events: ["Transfer", "AllowanceSpent", "ActionExecuted"],
    });

    // A contract that refuses the router: the call fails, the action still stands.
    b.call("root", "@whitelist", "setAllowed", ["@registry", true]);
    b.call(
      "worker",
      "@router",
      "propose",
      [
        "worker",
        "@registry",
        0n,
        { call: { to: "@registry", fn: "addNode", args: ["worker2", KIND.worker, "root"] } },
      ],
      { verdict: "ALLOW", events: ["ActionExecuted"] },
    );
    b.expect({ nodes: { worker2: null } });

    // A contract that accepts it: the callee's own effects land.
    b.call("root", "@whitelist", "setAllowed", ["@token", true]);
    b.call(
      "worker",
      "@router",
      "propose",
      ["worker", "@token", 0n, { call: { to: "@token", fn: "approve", args: ["target2", 5n] } }],
      { verdict: "ALLOW", events: ["Approval", "ActionExecuted"] },
    );

    // An escalated intent carries its calldata to the approval.
    const intent = b.escalate("worker", "worker", "target", 75n * USDC, "0xabcdef");
    b.resolve("manager", intent, true, {
      events: ["Transfer", "AllowanceSpent", "ActionExecuted", "IntentResolved"],
    });
    b.expect({ allowance: { worker: 115n * USDC }, balance: { target: 85n * USDC } });
  }),
];
