import { strict as assert } from "node:assert";
import { test } from "node:test";
import { flow } from "./builder.js";
import { crewSampleInputText, crewSampleRuns } from "./crewSamples.js";
import {
  evalAddress,
  evalCoverage,
  evalCrewBindings,
  formatEvalReport,
  runFlowEval,
  runFlowEvals,
  withNetworkBlocked,
  type FlowEvalScenario,
} from "./evals.js";
import { firstPartyEvals } from "./evalSuite.js";
import { getCrewBlueprint } from "./crewBlueprints.js";
import { getFlowTemplate } from "./templates.js";
import type { FlowDefinition, FlowStep } from "./types.js";

/** The scenario every other test in this file mutates around. */
const goldenMergeDeny = firstPartyEvals.find((s) => s.id === "github-experts/merge-refused")!;

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** A copy of a shipped template with one step replaced — the mutation lever. */
function mutate(flowId: string, stepId: string, patch: Record<string, unknown>): FlowDefinition {
  const def = clone(getFlowTemplate(flowId)!.definition);
  const step = def.steps.find((s) => s.id === stepId);
  assert.ok(step, `no step "${stepId}" in "${flowId}"`);
  Object.assign(step, patch);
  return def;
}

test("the first-party suite is green", async () => {
  const suite = await runFlowEvals(firstPartyEvals);
  assert.equal(suite.ok, true, formatEvalReport(suite));
  assert.equal(suite.failed, 0);
  assert.ok(suite.passed >= 5, "the seed suite should cover several blueprints");
});

/*
  The acceptance criterion the whole feature rests on (F2.29): break the flow so
  the merge no longer waits on the policy answer, and the golden scenario must
  go red naming the write route. An eval suite that stays green through this
  would be decoration.
*/
test("mutation: routing the refusal port at the merge makes the golden scenario fail", async () => {
  const broken = mutate("bot-pr-triage", "may-merge", { onFalse: "merge" });
  const result = await runFlowEval({
    ...clone(goldenMergeDeny),
    id: "mutant/deny-routes-to-merge",
    flow: undefined,
    definition: broken,
  } as FlowEvalScenario);

  assert.equal(result.ok, false, "a DENY that still merges must fail the eval");
  const named = result.failures.map((f) => f.assertion);
  assert.ok(named.includes("notCalled"), `expected a notCalled failure, got ${named.join(", ")}`);
  const write = result.failures.find((f) => f.assertion === "notCalled")!;
  assert.match(write.detail, /github\.merge_pull_request/);
});

test("mutation: skipping the policy check entirely makes the golden scenario fail", async () => {
  // The classifier's MERGE case goes straight to the write, with nothing asked.
  const broken = mutate("bot-pr-triage", "route", {
    cases: [
      { value: "MERGE", next: "merge" },
      { value: "FIX", next: "fix-budget" },
      { value: "HOLD", next: "hold-note" },
      { value: "REJECT", next: "reject-note" },
    ],
  });
  const result = await runFlowEval({
    ...clone(goldenMergeDeny),
    id: "mutant/no-policy-check",
    flow: undefined,
    definition: broken,
  } as FlowEvalScenario);

  assert.equal(result.ok, false);
  assert.ok(result.failures.some((f) => f.assertion === "notCalled"));
  assert.ok(
    result.failures.some((f) => f.assertion === "ran" || f.assertion === "port"),
    "the missing policy step should also break the expected path",
  );
});

test("mutation: a connector call added to the sign-off path breaks noConnectorCalls", async () => {
  const def = clone(getFlowTemplate("content-weekly-brief")!.definition);
  const publish: FlowStep = {
    id: "leak",
    kind: "tool",
    tool: "ghost.publish_post",
    args: { title: "{{steps.tally.text}}" },
    next: null,
  };
  def.steps.push(publish);
  const signoff = def.steps.find((s) => s.id === "signoff")!;
  Object.assign(signoff, { next: "leak" });

  const scenario = clone(
    firstPartyEvals.find((s) => s.id === "content-studio/publish-denied-ends-in-signoff")!,
  );
  const result = await runFlowEval({
    ...scenario,
    id: "mutant/publish-leak",
    flow: undefined,
    definition: def,
  } as FlowEvalScenario);

  assert.equal(result.ok, false, "a publish route on the DENY path must fail the eval");
  const leak = result.failures.find((f) => f.assertion === "noConnectorCalls");
  assert.ok(
    leak,
    `expected noConnectorCalls, got ${result.failures.map((f) => f.assertion).join(", ")}`,
  );
  assert.match(leak.detail, /ghost\.publish_post/);
});

/*
  The guard that stops an eval being made green by granting the crew authority
  the blueprint refuses it. The drift scenario is allowed to do this — it says
  so — and the same mocks without the declaration are not.
*/
test("a scenario cannot quietly admit a target its blueprint refuses", async () => {
  const drift = clone(firstPartyEvals.find((s) => s.id === "lp-advisor/router-admitted-is-drift")!);
  delete drift.mocks!.policy!.admitsUnadmitted;
  const result = await runFlowEval({ ...drift, id: "mutant/undeclared-admit" });

  assert.equal(result.ok, false);
  const guard = result.failures.find((f) => f.assertion === "mock_contradicts_blueprint");
  assert.ok(guard, "an undeclared ALLOW over an unadmitted target must be refused");
  assert.match(guard.detail, /dex-router/);
  assert.equal(result.run, undefined, "a contradicted scenario must not run at all");
});

test("a scenario cannot run a flow its seat does not own", async () => {
  const result = await runFlowEval({
    ...clone(goldenMergeDeny),
    id: "mutant/wrong-seat",
    // The watcher keeps the queue; the reviewer is what triages a PR.
    asAgent: "watcher",
  });
  assert.equal(result.ok, false);
  const seat = result.failures.find((f) => f.assertion === "setup");
  assert.ok(seat);
  assert.match(seat.detail, /does not run "bot-pr-triage"/);
});

test("the run executes as the seat the scenario names", async () => {
  const bp = getCrewBlueprint("github-experts")!;
  const bindings = evalCrewBindings(bp);
  const result = await runFlowEval(clone(goldenMergeDeny));
  assert.equal(result.run?.principal?.agent, bindings.roles.reviewer);
  assert.equal(result.run?.principal?.nodeKind, "worker_agent");
});

test("bindings are derived, stable, and unique per seat and target", () => {
  const a = evalCrewBindings(getCrewBlueprint("github-experts")!);
  const b = evalCrewBindings(getCrewBlueprint("github-experts")!);
  assert.deepEqual(a, b, "the same blueprint must bind to the same addresses every run");
  const all = [...Object.values(a.roles), ...Object.values(a.targets)];
  assert.equal(new Set(all).size, all.length, "two seats must not share an address");
  for (const address of all) assert.match(address, /^0x[0-9a-f]{40}$/);
  assert.notEqual(
    evalAddress("github-experts:crew:reviewer"),
    evalAddress("github-experts:crew:merger"),
  );
});

test("a run id is derived from the scenario, so a failure reads the same every time", async () => {
  const first = await runFlowEval(clone(goldenMergeDeny));
  const second = await runFlowEval(clone(goldenMergeDeny));
  assert.equal(first.run?.runId, second.run?.runId);
  assert.deepEqual(
    first.run?.steps.map((s) => s.stepId),
    second.run?.steps.map((s) => s.stepId),
  );
});

/*
  A gate stops the run and stays open. This is the one assertion that has to
  survive an offline suite: a canned yes would make a blocking gate look like
  one that passes.
*/
test("an unanswered human gate parks the run and reports the question open", async () => {
  const def = flow("eval-gate", "Gate under eval")
    .human("sign-off", {
      prompt: "Ship it?",
      options: [
        { id: "yes", port: "ship" },
        { id: "no", port: null },
      ],
    })
    .model("ship", { prompt: "Write the note.", next: null })
    .build();

  const parked = await runFlowEval({
    id: "gate/unanswered",
    definition: def,
    expect: {
      status: "waiting",
      waiting: { reason: "human_gate" },
      questionOpen: true,
      notRan: ["ship"],
    },
  });
  assert.equal(parked.ok, true, JSON.stringify(parked.failures, null, 2));
  assert.deepEqual(parked.gatesOpen, ["sign-off"]);

  const answered = await runFlowEval({
    id: "gate/answered",
    definition: def,
    mocks: {
      gates: {
        "sign-off": {
          outcome: "answered",
          optionId: "yes",
          answeredBy: "0xHUMAN",
        },
      },
    },
    expect: {
      status: "completed",
      ran: ["sign-off", "ship"],
      questionOpen: false,
    },
  });
  assert.equal(answered.ok, true, JSON.stringify(answered.failures, null, 2));
});

test("scripted model replies are consumed in order; unscripted ones are one constant", async () => {
  const def = flow("eval-two-turns", "Two turns")
    .model("first", { prompt: "Reply with A or B.", next: "second" })
    .model("second", { prompt: "Reply with A or B.", next: "third" })
    .model("third", { prompt: "Say anything.", next: null })
    .build();

  const result = await runFlowEval({
    id: "model/ordering",
    definition: def,
    mocks: { model: [{ reply: "A" }, { reply: "B" }] },
    expect: { status: "completed", called: { model: 3 } },
  });
  assert.equal(result.ok, true, JSON.stringify(result.failures, null, 2));
  const texts = result.run!.steps.map((s) => (s.output as { text?: string }).text);
  assert.deepEqual(texts.slice(0, 2), ["A", "B"]);
  assert.match(texts[2] ?? "", /^\[eval\]/);
});

test("a tool mock can fail a route, and the flow reports the failure rather than the write", async () => {
  const scenario: FlowEvalScenario = {
    ...clone(firstPartyEvals.find((s) => s.id === "github-experts/merge-admitted")!),
    id: "github-experts/merge-route-down",
  };
  scenario.mocks!.tools!["github.merge_pull_request"] = { error: "github_502" };
  scenario.expect = {
    status: "error",
    called: { "github.merge_pull_request": 1 },
    notRan: ["merge-note"],
    auditIncludes: ["github_502"],
  };
  const result = await runFlowEval(scenario);
  assert.equal(result.ok, true, JSON.stringify(result.failures, null, 2));
});

test("assertions bite: a wrong port, verdict, or call count fails", async () => {
  const wrongPort = await runFlowEval({
    ...clone(goldenMergeDeny),
    id: "assert/port",
    expect: { ...goldenMergeDeny.expect, port: { "may-merge": "merge" } },
  });
  assert.equal(wrongPort.ok, false);
  assert.equal(wrongPort.failures[0]?.assertion, "port");

  const wrongCount = await runFlowEval({
    ...clone(goldenMergeDeny),
    id: "assert/called",
    expect: { called: { "github.get_pull_request": 2 } },
  });
  assert.equal(wrongCount.ok, false);
  assert.match(wrongCount.failures[0]?.detail ?? "", /called 1×, expected 2×/);

  const wrongVerdict = await runFlowEval({
    ...clone(firstPartyEvals.find((s) => s.id === "defi-desk/oversized-trade-escalates")!),
    id: "assert/verdict",
    expect: { verdict: { trade: "ALLOW" } },
  });
  assert.equal(wrongVerdict.ok, false);
  assert.equal(wrongVerdict.failures[0]?.assertion, "verdict");
});

test("a scenario naming no runnable flow fails rather than passing vacuously", async () => {
  const result = await runFlowEval({
    id: "setup/missing",
    flow: "no-such-flow",
    expect: {},
  });
  assert.equal(result.ok, false);
  assert.equal(result.failures[0]?.assertion, "setup");
});

/*
  The invariant that makes "no real api.github.com in CI logs" a property of the
  runner rather than a promise: while a scenario runs, there is no fetch.
*/
test("the runner blocks the network for the duration of a run", async () => {
  const before = globalThis.fetch;
  const { attempts } = await withNetworkBlocked(async () => {
    await assert.rejects(
      () => fetch("https://api.github.com/repos/marc-aurele-besner/lacrew/pulls/94"),
      /eval_network_blocked/,
    );
  });
  assert.deepEqual(attempts, ["https://api.github.com/repos/marc-aurele-besner/lacrew/pulls/94"]);
  assert.equal(globalThis.fetch, before, "the real fetch must be restored afterwards");
});

test("coverage names the flows and blueprints no scenario touches", () => {
  const coverage = evalCoverage(firstPartyEvals);
  assert.equal(coverage.byFlow["bot-pr-triage"], 5);
  assert.ok(coverage.flowsWithoutEvals.includes("treasury-pulse"));
  assert.ok(!coverage.flowsWithoutEvals.includes("bot-pr-triage"));
  assert.ok(!coverage.blueprintsWithoutEvals.includes("github-experts"));
});

/*
  F2.25's certified path is what a new operator's first run actually does. A
  blueprint that ships one and has no eval for it is the gap this suite exists
  to close, so it fails here rather than being reported as coverage.
*/
test("every blueprint with a certified sample run has an eval for that flow", () => {
  const coverage = evalCoverage(firstPartyEvals);
  for (const sample of crewSampleRuns) {
    assert.ok(
      (coverage.byFlow[sample.flow] ?? 0) > 0,
      `"${sample.blueprint}" ships a certified sample of "${sample.flow}" with no eval`,
    );
  }
});

/*
  And the eval has to fire the fixture's *own* input. The product hands an
  operator one run input; a scenario pinning the same flow against a different
  one keeps passing after the fixture drifts into a brief the flow reads badly,
  which is precisely the failure the operator would meet first.
*/
test("a certified sample's input is the one its evals are run with", () => {
  for (const sample of crewSampleRuns) {
    const wire = crewSampleInputText(sample);
    const forFlow = firstPartyEvals.filter(
      (s) => s.blueprint === sample.blueprint && s.flow === sample.flow,
    );
    assert.ok(forFlow.length > 0, `no scenario runs "${sample.flow}" for "${sample.blueprint}"`);
    assert.ok(
      forFlow.some(
        (s) => (typeof s.input === "string" ? s.input : JSON.stringify(s.input)) === wire,
      ),
      `no "${sample.blueprint}" scenario fires the certified input for "${sample.flow}"`,
    );
  }
});

/*
  The second certified vertical's thesis, held from both ends (F2.25). The
  refusal is the state a fresh crew lands in; the admitted mirror is what a
  high-tier proposal would change. Without the pair, a `publish-allowed` branch
  wired to `signoff` on both ports would pass the DENY scenario forever.
*/
test("content-studio pins the publish verdict in both directions", async () => {
  const ids = [
    "content-studio/publish-denied-ends-in-signoff",
    "content-studio/publish-admitted-publishes",
  ];
  const scenarios = ids.map((id) => firstPartyEvals.find((s) => s.id === id));
  for (const [i, s] of scenarios.entries()) assert.ok(s, `missing scenario "${ids[i]}"`);

  const suite = await runFlowEvals(scenarios as FlowEvalScenario[]);
  assert.equal(suite.ok, true, formatEvalReport(suite));

  // The refusal must be a verdict the flow read, not a port it can only take.
  const broken = mutate("content-weekly-brief", "publish-allowed", { onTrue: "signoff" });
  const admitted = clone(
    firstPartyEvals.find((s) => s.id === "content-studio/publish-admitted-publishes")!,
  );
  const result = await runFlowEval({
    ...admitted,
    id: "mutant/allow-still-routes-to-signoff",
    flow: undefined,
    definition: broken,
  } as FlowEvalScenario);
  assert.equal(result.ok, false, "an ALLOW that still refuses must fail the eval");
  assert.ok(result.failures.some((f) => f.assertion === "port" || f.assertion === "ran"));
});

/*
  The desk's thesis, held from both ends (F2.25). Two separate claims live in
  these scenarios and both are load-bearing:

  - The scanner never reaches the money. Its cap would refuse the size, but
    "refused" is not the claim — the claim is that it never asks, which is what
    survives a policy module being misconfigured.
  - The executor reads a verdict rather than taking a port. ALLOW files a
    receipt, ESCALATE writes the memo, DENY stands down; a gate rewired so the
    refusal lands on the receipt would pass any suite that only asserted the run
    completed.
*/
test("defi-desk pins the scanner's silence and the executor's verdicts", async () => {
  const ids = [
    "defi-desk/scanner-hands-the-trade-down",
    "defi-desk/clip-size-trade-executes",
    "defi-desk/unadmitted-venue-stands-down",
    "defi-desk/oversized-trade-escalates",
  ];
  const scenarios = ids.map((id) => firstPartyEvals.find((s) => s.id === id));
  for (const [i, s] of scenarios.entries()) assert.ok(s, `missing scenario "${ids[i]}"`);
  const suite = await runFlowEvals(scenarios as FlowEvalScenario[]);
  assert.equal(suite.ok, true, formatEvalReport(suite));

  // A scanner that proposed for itself instead of delegating.
  const spends = mutate("desk-opportunity-scan", "hand-off", {
    kind: "gate",
    target: "{{target.dex-router}}",
    value: "200000000",
    onAllow: "log",
    onEscalate: "log",
    onDeny: "log",
  });
  const grabby = await runFlowEval({
    ...clone(firstPartyEvals.find((s) => s.id === "defi-desk/scanner-hands-the-trade-down")!),
    id: "mutant/scanner-proposes-for-itself",
    flow: undefined,
    definition: spends,
  } as FlowEvalScenario);
  assert.equal(grabby.ok, false, "a scanner that proposes must fail the eval");
  assert.ok(grabby.failures.some((f) => f.assertion === "notCalled"));

  // A refusal that files a receipt anyway: the venue check reads DENY and the
  // branch carries on regardless, which is the edge the whole thesis lives in.
  const paysAnyway = mutate("desk-execute-trade", "admitted", { onTrue: "receipt" });
  const result = await runFlowEval({
    ...clone(firstPartyEvals.find((s) => s.id === "defi-desk/unadmitted-venue-stands-down")!),
    id: "mutant/deny-files-a-receipt",
    flow: undefined,
    definition: paysAnyway,
  } as FlowEvalScenario);
  assert.equal(result.ok, false, "a DENY that still files a receipt must fail the eval");
  assert.ok(
    result.failures.some((f) => ["port", "ran", "notRan"].includes(f.assertion)),
    result.failures.map((f) => f.assertion).join(", "),
  );
});

test("the report names the scenario, the assertion, and the coverage warning", async () => {
  const suite = await runFlowEvals([
    {
      ...clone(goldenMergeDeny),
      id: "report/failing",
      expect: { status: "error" },
    },
  ]);
  const report = formatEvalReport(suite, evalCoverage(firstPartyEvals));
  assert.match(report, /✗ report\/failing/);
  assert.match(report, /status: run ended "completed", expected "error"/);
  assert.match(report, /first-party flow\(s\) have no eval/);
});
