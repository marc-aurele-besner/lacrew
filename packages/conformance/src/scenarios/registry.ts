/**
 * The org tree, and the wiring of the router that reads it.
 */

import { KIND, USDC, scenario, type Scenario } from "../scenario.js";

export const registryScenarios: Scenario[] = [
  scenario("the org tree: add, deactivate, reparent, remove", (b) => {
    b.reverts("NotAuthorized", "stranger", "@registry", "addNode", [
      "manager",
      KIND.manager,
      "root",
    ]);
    b.call("root", "@registry", "addNode", ["manager", KIND.manager, "root"], {
      events: ["NodeAdded"],
    });
    b.call("root", "@registry", "addNode", ["manager2", KIND.manager, "root"]);
    b.call("root", "@registry", "addNode", ["worker", KIND.worker, "manager"]);
    b.call("root", "@registry", "addNode", ["worker2", KIND.worker, "manager"]);
    b.reverts("NodeAlreadyExists", "root", "@registry", "addNode", ["worker", KIND.worker, "root"]);
    b.reverts("InvalidParent", "root", "@registry", "addNode", ["target", KIND.worker, "stranger"]);
    b.expect({
      tree: ["root", "manager", "manager2", "worker", "worker2"],
      nodes: {
        root: { parent: null, kind: "human_root", active: true },
        manager: { parent: "root", kind: "manager_agent" },
        worker: { parent: "manager", kind: "worker_agent", active: true },
      },
    });

    b.reverts("NodeNotFound", "root", "@registry", "setActive", ["stranger", false]);
    b.reverts("CannotMutateRoot", "root", "@registry", "setActive", ["root", false]);
    b.reverts("NotAuthorized", "stranger", "@registry", "setActive", ["worker", false]);
    b.call("root", "@registry", "setActive", ["worker", false], { events: ["NodeActiveUpdated"] });
    b.expect({ nodes: { worker: { active: false, parent: "manager" } } });

    b.reverts("CyclicParent", "root", "@registry", "reparent", ["manager", "manager"]);
    b.reverts("CyclicParent", "root", "@registry", "reparent", ["manager", "worker"]);
    b.reverts("CannotMutateRoot", "root", "@registry", "reparent", ["root", "manager"]);
    b.reverts("InvalidParent", "root", "@registry", "reparent", ["worker", "stranger"]);
    b.reverts("NodeNotFound", "root", "@registry", "reparent", ["stranger", "root"]);
    b.reverts("NotAuthorized", "stranger", "@registry", "reparent", ["worker", "root"]);
    b.call("root", "@registry", "reparent", ["worker2", "manager2"], {
      events: ["NodeReparented"],
    });
    // Moving a node to the parent it already has changes nothing and emits nothing.
    b.call("root", "@registry", "reparent", ["worker2", "manager2"], { events: [] });
    b.expect({ nodes: { worker2: { parent: "manager2" } } });

    b.reverts("CannotMutateRoot", "root", "@registry", "removeNode", ["root"]);
    b.reverts("NodeNotFound", "root", "@registry", "removeNode", ["stranger"]);
    b.reverts("NotAuthorized", "stranger", "@registry", "removeNode", ["manager"]);
    b.call("root", "@registry", "removeNode", ["manager"], { events: ["NodeRemoved"] });
    b.expect(
      {
        // The removed node's children are appended to its parent before it is swapped out.
        tree: ["root", "worker", "manager2", "worker2"],
        nodes: { manager: null, worker: { parent: "root", active: false } },
      },
      "children are rewired to the removed node's parent",
    );

    b.reverts("ZeroAddress", "root", "@registry", "setGovernor", ["zero"]);
    b.reverts("NotAuthorized", "stranger", "@registry", "setGovernor", ["stranger"]);
    b.call("root", "@registry", "setGovernor", ["human2"]);
    b.reverts("NotAuthorized", "root", "@registry", "addNode", ["target", KIND.worker, "root"]);
    b.reverts("NotAuthorized", "root", "@registry", "setGovernor", ["root"]);
    b.call("human2", "@registry", "addNode", ["target", KIND.worker, "root"]);
    b.call("human2", "@registry", "setGovernor", ["root"]);
    b.call("root", "@registry", "removeNode", ["target"]);
  }),

  scenario("the zero address can be added as a node the tree then cannot read", (b) => {
    // addNode has no zero-address check; getNode treats a zero account as absent.
    b.call("root", "@registry", "addNode", ["zero", KIND.worker, "root"], {
      events: ["NodeAdded"],
    });
    b.expect({ treeUnreadable: true });
    b.call("root", "@registry", "addNode", ["zero", KIND.worker, "root"]);
    b.reverts("NodeNotFound", "root", "@registry", "removeNode", ["zero"]);
  }),

  scenario("a router wired to an address with no code reverts without an error", (b) => {
    b.crew();
    // A recorder that is not a contract: the action cannot be counted, so it cannot happen.
    b.call("root", "@router", "setRateRecorder", ["stranger"]);
    b.proposeReverts("EvmRevert", "worker", "worker", "target", 1n);
    b.proposeReverts("EvmRevert", "worker", "worker", "target", 75n * USDC);
    b.call("root", "@router", "setRateRecorder", ["@rateLimit"]);

    // A treasury that is not a contract: a spend has nowhere to come from.
    b.call("root", "@router", "setTreasury", ["stranger"]);
    b.proposeReverts("EvmRevert", "worker", "worker", "target", 1n);
    // Nothing is spent on a zero-value action, so the treasury is never called.
    b.allow("worker", "worker", "target", 0n);
    b.call("root", "@router", "setTreasury", ["@treasury"]);

    // A session registry that is not a contract: no key can be checked, no propose counted.
    b.call("root", "@router", "setSessionRegistry", ["stranger"]);
    b.proposeReverts("EvmRevert", "key", "worker", "target", 1n);
    b.proposeReverts("EvmRevert", "worker", "worker", "target", 1n);
    b.call("root", "@router", "setSessionRegistry", ["@sessions"]);

    // A policy that is a contract, but not a policy module.
    b.call("root", "@router", "setNodePolicy", ["worker", "@token"]);
    b.proposeReverts("EvmRevert", "worker", "worker", "target", 1n);
    b.call("root", "@router", "setNodePolicy", ["worker", "zero"]);
    b.allow("worker", "worker", "target", 1n);
    b.expect({ allowance: { worker: 200n * USDC - 1n } });
  }),

  scenario("a value outside an enum is refused before the function runs", (b) => {
    b.reverts("EvmRevert", "root", "@registry", "addNode", ["manager", 3, "root"]);
    b.reverts("EvmRevert", "root", "@gov", "propose", [2, "target", "0x"]);
    b.reverts("EvmRevert", "root", "@gov", "setVotingPower", ["manager", 1n, 3]);
    b.expect({ tree: ["root"] });
  }),

  scenario("the router is wired by its deployer, then by its governor alone", (b) => {
    b.crew();
    for (const [fn, args] of [
      ["setTreasury", ["stranger"]],
      ["setRateRecorder", ["stranger"]],
      ["setSessionRegistry", ["stranger"]],
      ["setNodePolicy", ["worker", "stranger"]],
      ["setNodeRateRecorder", ["worker", "stranger"]],
      ["setGovernor", ["stranger"]],
    ] as const) {
      b.reverts("NotAuthorized", "stranger", "@router", fn, [...args]);
    }
    b.reverts("ZeroAddress", "root", "@router", "setNodePolicy", ["zero", "@policyStack"]);
    b.reverts("ZeroAddress", "root", "@router", "setNodeRateRecorder", ["zero", "@rateLimit"]);
    // setGovernor rejects a zero governor before it asks who is calling.
    b.reverts("ZeroAddress", "stranger", "@router", "setGovernor", ["zero"]);

    // No session registry: anyone may propose for an agent.
    b.call("root", "@router", "setSessionRegistry", ["zero"], {
      events: ["SessionRegistryUpdated"],
    });
    b.allow("stranger", "worker", "target", 1n * USDC);
    // No recorder: actions are not counted.
    b.call("root", "@router", "setRateRecorder", ["zero"], { events: ["RateRecorderUpdated"] });
    b.allow("worker", "worker", "target", 1n * USDC);
    // No treasury: an allowed action executes without a spend.
    b.call("root", "@router", "setTreasury", ["zero"], { events: ["TreasuryUpdated"] });
    b.call("worker", "@router", "propose", ["worker", "target", 5n * USDC, "0x"], {
      verdict: "ALLOW",
      events: ["ActionExecuted"],
    });
    b.expect({ allowance: { worker: 198n * USDC }, balance: { target: 2n * USDC } });

    b.call("root", "@router", "setGovernor", ["human2"], { events: ["GovernorUpdated"] });
    b.reverts("NotAuthorized", "root", "@router", "setTreasury", ["@treasury"]);
    b.call("human2", "@router", "setTreasury", ["@treasury"]);
    b.call("human2", "@router", "setRateRecorder", ["@rateLimit"]);
    b.call("human2", "@router", "setSessionRegistry", ["@sessions"]);
    b.proposeReverts("InvalidSession", "stranger", "worker", "target", 1n);
    b.allow("worker", "worker", "target", 1n * USDC);
    b.expect({ allowance: { worker: 197n * USDC } });
  }),
];
