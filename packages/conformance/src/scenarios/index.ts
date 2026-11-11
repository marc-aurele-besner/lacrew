import type { Scenario } from "../scenario.js";
import { governanceScenarios } from "./governance.js";
import { policyScenarios } from "./policies.js";
import { registryScenarios } from "./registry.js";
import { sessionScenarios } from "./sessions.js";
import { spendScenarios } from "./spend.js";
import { treasuryScenarios } from "./treasury.js";

/** Every scenario, in the order the suite runs them. */
export const SCENARIOS: Scenario[] = [
  ...spendScenarios,
  ...sessionScenarios,
  ...policyScenarios,
  ...treasuryScenarios,
  ...registryScenarios,
  ...governanceScenarios,
];
