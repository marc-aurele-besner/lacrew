/**
 * Policy modules: the rate limit and time window as the router sees them, a
 * node's own stack, and who may administer each module.
 */

import { DAY, HOUR, MAX_UINT256, USDC, scenario, type Scenario } from "../scenario.js";

export const policyScenarios: Scenario[] = [
  scenario(
    "the policy rate limit escalates a full window and allows again the second it rolls over",
    (b) => {
      b.crew();
      // The window opens with the first counted action, at second T.
      b.allow("worker", "worker", "target", 1n);
      b.allow("worker", "worker", "target", 1n);
      b.expect({
        verdicts: [{ agent: "worker", target: "target", value: 1n, verdict: "ESCALATE" }],
      });
      const intent = b.escalate("worker", "worker", "target", 1n);
      b.expect({ pending: [intent] });
      b.warp(HOUR - 4);
      // T + 3599: the last second of the window.
      b.escalate("worker", "worker", "target", 1n);
      // T + 3600: a new one.
      b.allow("worker", "worker", "target", 1n);
      // Each agent is counted in its own window.
      b.call("root", "@router", "setNodePolicy", ["manager", "@policyStack"]);
      b.allow("manager", "manager", "target", 0n);
    },
    { rateLimit: { maxActions: 2n, windowSeconds: BigInt(HOUR) } },
  ),

  scenario(
    "the policy time window allows [start, end) of the UTC day",
    (b) => {
      b.crew();
      b.expect({ secondOfDay: 81_010 });
      b.allow("worker", "worker", "target", 1n);
      b.warp(7);
      // 81 019: the last second inside.
      b.allow("worker", "worker", "target", 1n);
      // 81 020: the end is outside.
      b.proposeReverts("UnexpectedVerdict", "worker", "worker", "target", 1n);
      b.warp(1);
      b.expect({
        secondOfDay: 81_020,
        verdicts: [
          { agent: "worker", target: "target", value: 1n, verdict: "DENY" },
          {
            agent: "worker",
            target: "target",
            value: 1n,
            verdict: "DENY",
            module: "@timeWindow",
          },
          // The manager's stack carries no window.
          {
            agent: "manager",
            target: "target",
            value: 1n,
            verdict: "ALLOW",
            module: "@managerStack",
          },
        ],
        denials: [
          {
            agent: "worker",
            target: "target",
            value: 1n,
            by: "@timeWindow",
            reason: "outside_time_window",
          },
          { agent: "manager", target: "target", value: 1n, by: null },
        ],
      });
      // The next day: 80 999 is still outside, 81 000 is the start.
      b.warp(DAY - 22);
      b.proposeReverts("UnexpectedVerdict", "worker", "worker", "target", 1n);
      b.warp(1);
      b.allow("worker", "worker", "target", 1n);
      b.expect({ secondOfDay: 81_000 });
    },
    { timeWindow: { startSecondOfDay: 81_000n, endSecondOfDay: 81_020n } },
  ),

  scenario("a node's own stack and its own rate recorder", (b) => {
    b.crew();
    b.deploy("root", "RateLimitPolicy", "rl", [1n, BigInt(HOUR)]);
    b.reverts("NotAuthorized", "stranger", "$rl", "setRecorder", ["@router"]);
    b.reverts("ZeroAddress", "root", "$rl", "setRecorder", ["zero"]);
    // Until a recorder is bound the deployer may record, and only the deployer.
    b.reverts("NotRecorder", "stranger", "$rl", "record", ["manager"]);
    b.call("root", "$rl", "record", ["manager"]);
    b.call("root", "$rl", "setRecorder", ["@router"], { events: ["RecorderBound"] });
    b.reverts("RecorderLocked", "root", "$rl", "setRecorder", ["stranger"]);
    b.reverts("NotRecorder", "root", "$rl", "record", ["manager"]);

    b.deploy("root", "PolicyStack", "none", [[]], "EmptyStack");
    b.deploy("root", "TimeWindowPolicy", "bad", [10n, 10n], "InvalidWindow");
    b.deploy("root", "TimeWindowPolicy", "bad", [0n, BigInt(DAY + 1)], "InvalidWindow");
    b.deploy("root", "TimeWindowPolicy", "always", [0n, BigInt(DAY)]);
    b.deploy("root", "PolicyStack", "stack", [["@whitelist", "$rl", "$always"]]);

    b.call("root", "@router", "setNodePolicy", ["worker", "$stack"]);
    b.call("root", "@router", "setNodeRateRecorder", ["worker", "$rl"]);
    // No spend cap in this stack: only the rate limit stands between the worker and its allowance.
    b.allow("worker", "worker", "target", 150n * USDC);
    const intent = b.escalate("worker", "worker", "target", 1n);
    b.expect({
      pending: [intent],
      allowance: { worker: 50n * USDC },
      verdicts: [
        { agent: "worker", target: "target", value: 1n, verdict: "ESCALATE", module: "$stack" },
        { agent: "worker", target: "target", value: 1n, verdict: "ESCALATE", module: "$rl" },
        { agent: "root", target: "target", value: 1n, verdict: "ALLOW", module: "$rl" },
      ],
    });
    // Unbinding falls back to the router's default stack and recorder.
    b.call("root", "@router", "setNodePolicy", ["worker", "zero"]);
    b.call("root", "@router", "setNodeRateRecorder", ["worker", "zero"]);
    b.allow("worker", "worker", "target", 1n);
  }),

  scenario("who administers a spend cap and a whitelist", (b) => {
    for (const module of ["@spendCap", "@whitelist"]) {
      b.reverts("NotAuthorized", "stranger", module, "setGovernor", ["@gov"]);
      b.reverts("ZeroAddress", "root", module, "setGovernor", ["zero"]);
    }
    b.reverts("NotAuthorized", "stranger", "@spendCap", "setAgentCap", ["worker", 1n]);
    b.reverts("NotAuthorized", "stranger", "@whitelist", "setAllowed", ["target", true]);
    b.call("root", "@spendCap", "setGovernor", ["human2"]);
    b.call("root", "@whitelist", "setGovernor", ["human2"]);
    b.reverts("GovernorAlreadySet", "root", "@spendCap", "setGovernor", ["@gov"]);
    b.reverts("GovernorAlreadySet", "root", "@whitelist", "setGovernor", ["@gov"]);
    // The admin keeps its authority alongside the governor's.
    b.call("root", "@spendCap", "setAgentCap", ["worker", 7n], { events: ["AgentCapSet"] });
    b.call("human2", "@spendCap", "setAgentCap", ["manager", 0n]);
    b.call("human2", "@whitelist", "setAllowed", ["target", true], { events: ["TargetAllowed"] });
    b.expect({
      caps: { worker: 7n, manager: 0n, stranger: 50n * USDC },
      verdicts: [
        { agent: "worker", target: "target", value: 7n, verdict: "ALLOW", module: "@spendCap" },
        { agent: "worker", target: "target", value: 8n, verdict: "ESCALATE", module: "@spendCap" },
        // An explicit cap of zero is a cap, not "unset".
        { agent: "manager", target: "target", value: 1n, verdict: "ESCALATE", module: "@spendCap" },
        { agent: "manager", target: "target", value: 0n, verdict: "ALLOW", module: "@spendCap" },
        { agent: "worker", target: "target", value: 0n, verdict: "ALLOW", module: "@whitelist" },
        { agent: "worker", target: "target2", value: 0n, verdict: "DENY", module: "@whitelist" },
      ],
      denials: [
        {
          agent: "worker",
          target: "target2",
          value: 0n,
          by: "@whitelist",
          reason: "target_not_allowlisted",
        },
        // Over the cap is an escalation, which no module denies.
        { agent: "worker", target: "target", value: 8n, by: null },
      ],
    });

    // A module anyone deploys answers to its own deployer.
    b.deploy("stranger", "SpendCapPolicy", "cap2", [7n]);
    b.reverts("NotAuthorized", "root", "$cap2", "setAgentCap", ["worker", 1n]);
    b.call("stranger", "$cap2", "setAgentCap", ["worker", 9n]);
    b.deploy("stranger", "WhitelistPolicy", "wl2");
    b.reverts("NotAuthorized", "root", "$wl2", "setAllowed", ["target", true]);
    b.call("stranger", "$wl2", "setAllowed", ["target2", true]);
    b.expect({
      verdicts: [
        { agent: "worker", target: "target", value: 9n, verdict: "ALLOW", module: "$cap2" },
        { agent: "worker", target: "target", value: 10n, verdict: "ESCALATE", module: "$cap2" },
        { agent: "root", target: "target", value: 8n, verdict: "ESCALATE", module: "$cap2" },
        { agent: "worker", target: "target2", value: 0n, verdict: "ALLOW", module: "$wl2" },
        { agent: "worker", target: "target", value: 0n, verdict: "DENY", module: "$wl2" },
      ],
    });
  }),

  scenario("a rate limit whose window cannot end panics instead of answering", (b) => {
    b.crew();
    b.deploy("root", "RateLimitPolicy", "forever", [1n, MAX_UINT256]);
    b.deploy("root", "PolicyStack", "stack", [["@whitelist", "$forever"]]);
    b.call("root", "@router", "setNodePolicy", ["worker", "$stack"]);
    // No window yet: nothing to add.
    b.allow("worker", "worker", "target", 1n);
    // Once one is open, its end is start + windowSeconds, in checked arithmetic.
    b.call("root", "$forever", "record", ["worker"]);
    b.proposeReverts("Panic", "worker", "worker", "target", 1n);
    b.reverts("Panic", "root", "$forever", "record", ["worker"]);
  }),

  scenario("a policy that is not a module reverts without an error", (b) => {
    b.crew();
    b.call("root", "@router", "setNodePolicy", ["worker", "stranger"]);
    b.proposeReverts("EvmRevert", "worker", "worker", "target", 1n);
    // A stack reaches its members one by one; the missing one is where it stops.
    b.deploy("root", "PolicyStack", "broken", [["@whitelist", "stranger"]]);
    b.call("root", "@router", "setNodePolicy", ["worker", "$broken"]);
    b.proposeReverts("EvmRevert", "worker", "worker", "target", 1n);
    b.call("root", "@router", "setNodePolicy", ["worker", "zero"]);
    b.allow("worker", "worker", "target", 1n);
  }),
];
