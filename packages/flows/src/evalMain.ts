/**
 * `pnpm --filter @lacrew/flows eval` — the CI entry point for the first-party
 * eval suite (F2.29).
 *
 * Separate from the test runner on purpose: this is the check a PR touching
 * flows, blueprints, or connectors has to pass, and it prints the coverage warn
 * — which flows have no scenario — where the person adding one will read it.
 * `lacrew flows eval` runs the same suite through the CLI for design partners.
 */

import { evalCoverage, formatEvalReport, runFlowEvals } from "./evals.js";
import { firstPartyEvals } from "./evalSuite.js";

const suite = await runFlowEvals(firstPartyEvals);
console.log(formatEvalReport(suite, evalCoverage(firstPartyEvals)));
if (!suite.ok) process.exitCode = 1;
