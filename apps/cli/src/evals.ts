/**
 * `lacrew flows eval` / `lacrew crews eval` — run the deterministic scenario
 * suite offline (F2.29).
 *
 * One command behind two nouns, because operators arrive from both directions:
 * someone editing a pipeline asks "did I break a flow", someone shipping a
 * vertical asks "does this crew still refuse what it promises to refuse". The
 * suite is the same either way, and so is the exit code — non-zero when any
 * scenario fails, so a design partner can wire it into their own CI.
 *
 * Nothing here reaches a network: the harness blocks `fetch` for the duration
 * of every run, so this is safe to run against a laptop with live credentials
 * in the environment.
 */

import {
  evalCoverage,
  firstPartyEvals,
  formatEvalReport,
  runFlowEvals,
  type FlowEvalScenario,
} from "@lacrew/flows";

function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}

/**
 * A ref matches a scenario by its id, the flow it runs, or the blueprint it
 * belongs to — the three names an operator actually has in hand.
 */
function matches(scenario: FlowEvalScenario, ref: string): boolean {
  const needle = ref.toLowerCase();
  return (
    scenario.id.toLowerCase().includes(needle) ||
    (scenario.flow ?? scenario.definition?.id ?? "").toLowerCase() === needle ||
    (scenario.blueprint ?? "").toLowerCase() === needle
  );
}

export type EvalScope = "flows" | "crews";

export async function cmdEval(args: string[], scope: EvalScope): Promise<void> {
  const refs = args.filter((a) => !a.startsWith("-"));
  const scenarios =
    refs.length === 0
      ? [...firstPartyEvals]
      : firstPartyEvals.filter((s) => refs.some((ref) => matches(s, ref)));

  if (scenarios.length === 0) {
    console.error(
      `No scenario matches ${refs.map((r) => `"${r}"`).join(", ")}. ` +
        `See them all:  lacrew ${scope} eval --list`,
    );
    process.exitCode = 1;
    return;
  }

  if (hasFlag(args, "--list")) {
    for (const s of scenarios) {
      console.log(
        `${s.id}  · ${s.flow ?? s.definition?.id ?? "?"}` +
          `${s.blueprint ? ` · ${s.blueprint}` : ""}${s.asAgent ? ` · as ${s.asAgent}` : ""}`,
      );
      if (s.describe) console.log(`  ${s.describe}`);
    }
    console.log(
      `\n${scenarios.length} scenario(s). Run them:  lacrew ${scope} eval`,
    );
    return;
  }

  const suite = await runFlowEvals(scenarios);

  if (hasFlag(args, "--json")) {
    // Traces are the bulky part and a machine reader wants the verdict, not the
    // prose: ids, assertions, and what was called.
    console.log(
      JSON.stringify(
        {
          ok: suite.ok,
          passed: suite.passed,
          failed: suite.failed,
          results: suite.results.map((r) => ({
            id: r.id,
            ok: r.ok,
            flowId: r.flowId,
            status: r.run?.status,
            failures: r.failures,
            calls: r.calls.map((c) => c.name),
          })),
        },
        null,
        2,
      ),
    );
    if (!suite.ok) process.exitCode = 1;
    return;
  }

  // Coverage only means something over the whole suite; printed under a filter
  // it would read as "these flows have no eval" when they simply were not run.
  console.log(
    formatEvalReport(
      suite,
      refs.length === 0 ? evalCoverage(firstPartyEvals) : undefined,
    ),
  );
  if (!suite.ok) process.exitCode = 1;
}
