/**
 * Run part of the eval suite and print the result as JSON (F2.29).
 *
 * WHY THIS IS A SEPARATE PROCESS, and not a function the orchestrator calls.
 *
 * The harness blocks `globalThis.fetch` for the duration of a run — that is how
 * "an eval never leaves the machine" is a property rather than a promise. In a
 * long-lived server that block is process-wide: a connector call from a real
 * flow, a model completion, an RPC read, anything that happened to be in flight
 * while an operator pressed "run evals" would fail with `eval_network_blocked`.
 * A funded crew's work must not break because somebody ran a test.
 *
 * So the server spawns this, and the blast radius of the block is a process
 * that exists to be blocked.
 *
 * Usage (the orchestrator's `POST /flows/eval` does this for you):
 *   node dist/evalRun.js --ids scenario-a,scenario-b
 *   node dist/evalRun.js --flow github-pr-merge
 *   node dist/evalRun.js --blueprint github-experts
 *   node dist/evalRun.js --list
 *
 * stdout is one JSON document and nothing else, so a caller can parse it
 * without scraping logs; diagnostics go to stderr.
 */

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { runFlowEvals, type FlowEvalScenario } from "./evals.js";
import { firstPartyEvals } from "./evalSuite.js";

function flagValue(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  const value = i >= 0 ? argv[i + 1] : undefined;
  return value && !value.startsWith("--") ? value : undefined;
}

/** The scenarios an operator asked for; everything, when they named nothing. */
export function selectEvalScenarios(
  scenarios: readonly FlowEvalScenario[],
  filter: { ids?: string[]; flow?: string; blueprint?: string },
): FlowEvalScenario[] {
  const ids = new Set((filter.ids ?? []).filter(Boolean));
  return scenarios.filter((scenario) => {
    if (ids.size > 0 && !ids.has(scenario.id)) return false;
    // `flow` matches the template id a scenario names *or* the definition it
    // carries inline, so a filter works for both shapes.
    if (filter.flow && scenario.flow !== filter.flow && scenario.definition?.id !== filter.flow) {
      return false;
    }
    if (filter.blueprint && scenario.blueprint !== filter.blueprint) return false;
    return true;
  });
}

/** What a caller can run here, without running it. */
export function listEvalScenarios(
  scenarios: readonly FlowEvalScenario[],
): Array<{ id: string; describe?: string; flow?: string; blueprint?: string }> {
  return scenarios.map((scenario) => ({
    id: scenario.id,
    ...(scenario.describe ? { describe: scenario.describe } : {}),
    ...((scenario.flow ?? scenario.definition?.id)
      ? { flow: scenario.flow ?? scenario.definition!.id }
      : {}),
    ...(scenario.blueprint ? { blueprint: scenario.blueprint } : {}),
  }));
}

async function main(argv: string[]): Promise<void> {
  if (argv.includes("--list")) {
    process.stdout.write(JSON.stringify({ scenarios: listEvalScenarios(firstPartyEvals) }));
    return;
  }

  const selected = selectEvalScenarios(firstPartyEvals, {
    ...(flagValue(argv, "--ids") ? { ids: flagValue(argv, "--ids")!.split(",") } : {}),
    ...(flagValue(argv, "--flow") ? { flow: flagValue(argv, "--flow")! } : {}),
    ...(flagValue(argv, "--blueprint") ? { blueprint: flagValue(argv, "--blueprint")! } : {}),
  });

  if (selected.length === 0) {
    // Not an error, and deliberately not an empty pass either: "0 scenarios, all
    // green" is the shape of a suite that silently stopped testing anything.
    process.stdout.write(
      JSON.stringify({ ok: true, passed: 0, failed: 0, results: [], matched: 0 }),
    );
    return;
  }

  const suite = await runFlowEvals(selected);
  process.stdout.write(
    JSON.stringify({
      ok: suite.ok,
      passed: suite.passed,
      failed: suite.failed,
      matched: selected.length,
      // The run trace is dropped: it carries every step's output, which is
      // unbounded and is not what a result surface reads. Failures, the calls
      // that were made, and open gates are.
      results: suite.results.map((result) => ({
        id: result.id,
        ok: result.ok,
        flowId: result.flowId,
        ...(result.describe ? { describe: result.describe } : {}),
        failures: result.failures,
        calls: result.calls.map((call) => ({
          kind: call.kind,
          name: call.name,
          ...(call.connector ? { connector: call.connector } : {}),
        })),
        gatesOpen: result.gatesOpen,
        ...(result.run?.status ? { status: result.run.status } : {}),
      })),
    }),
  );
}

// Only when executed, so the selectors above stay importable by tests. Both
// sides are realpath'd: pnpm's workspace links mean the same file is reachable
// under two paths, and a string compare would run nothing under one of them.
const invoked = process.argv[1] ? realpathSync(process.argv[1]) : "";
if (invoked && invoked === realpathSync(fileURLToPath(import.meta.url))) {
  await main(process.argv.slice(2));
}
