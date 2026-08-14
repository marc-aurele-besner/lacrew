/**
 * The policy modules LaCrew ships as listings (PRD F3.1).
 *
 * The point of a first-party entry is that the whole path — publish, price,
 * buy, claim, attach through governance — is exercised by something real
 * before any third party exists. So these describe modules a deployment
 * already carries (`standardModule`), not a contract this file introduces:
 * what is new is the *distribution*, and inventing a module to demonstrate it
 * would test the demonstration rather than the path.
 *
 * They carry no price. Registering one on MarketplacePayments is a seller's
 * act with a seller's wallet behind it, and a shipped catalog entry has
 * neither.
 */

import type { PolicyModuleListing } from "./policyModules.js";

/**
 * TimeWindowPolicy — the module in the reference worker stack.
 *
 * Its window is a constructor immutable, so "attach the time window" means
 * binding the module the deployment already has; changing the hours means
 * deploying another one, which is `proposeNodePolicyStack`'s job and not this
 * listing's. It is the honest first example precisely because it DENYs: a
 * module that can only escalate would not show that a bought guardrail still
 * cannot bypass the stack order the org voted.
 */
const timeWindow: PolicyModuleListing = {
  id: "time-window",
  version: "1.0.0",
  name: "Trading-hours window",
  summary:
    "DENY every call outside a daily UTC window. Binds the TimeWindowPolicy your deployment already carries; the hours are fixed at deploy time, so attaching it enforces the window the address book holds.",
  standardModule: "time_window",
  deployments: [],
  slots: ["worker_agent", "manager_agent"],
  audit: {
    status: "third-party",
    notes:
      "Ships with the protocol and is covered by contracts/test/TimeWindowPolicy.sol and SessionTimeWindow.t.sol. The Phase 1 external audit (F1.4) covers it with the rest of the enforcement path.",
  },
  sourceUrl:
    "https://github.com/marc-aurele-besner/lacrew/blob/main/contracts/src/policies/TimeWindowPolicy.sol",
  tags: ["policy", "guardrail", "time"],
};

/** Modules LaCrew lists. Attaching one is still a governance vote. */
export const firstPartyPolicyModules: PolicyModuleListing[] = [timeWindow];

export function getPolicyModuleListing(id: string): PolicyModuleListing | undefined {
  return firstPartyPolicyModules.find((listing) => listing.id === id);
}
