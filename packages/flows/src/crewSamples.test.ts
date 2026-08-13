import { strict as assert } from "node:assert";
import { test } from "node:test";
import { getCrewBlueprint } from "./crewBlueprints.js";
import {
  crewFlowDelegates,
  crewFlowNeeds,
  crewFlowOwner,
  crewSampleInputText,
  crewSampleNeeds,
  crewSampleRun,
  crewSampleRuns,
  flowInputKeys,
  flowReadsWholeInput,
} from "./crewSamples.js";
import { getFlowTemplate } from "./templates.js";
import { flow } from "./builder.js";

test("every sample names a blueprint that ships the flow it runs", () => {
  for (const sample of crewSampleRuns) {
    const bp = getCrewBlueprint(sample.blueprint);
    assert.ok(bp, `sample names unknown blueprint "${sample.blueprint}"`);
    assert.ok(
      bp.flows.includes(sample.flow),
      `blueprint "${sample.blueprint}" does not ship flow "${sample.flow}"`,
    );
    assert.ok(getFlowTemplate(sample.flow), `flow "${sample.flow}" is not a known template`);
  }
});

/*
  The check that keeps a fixture honest as its flow changes. A step that starts
  reading `input.branch` would otherwise leave the sample supplying three of
  four fields and failing at the connector with a missing path argument — which
  an operator reads as "the product is broken", not "the fixture went stale".
*/
test("every sample supplies each input key its flow reads", () => {
  for (const sample of crewSampleRuns) {
    const def = getFlowTemplate(sample.flow)!.definition;
    const keys = flowInputKeys(def);
    assert.ok(
      keys.length > 0 || flowReadsWholeInput(def),
      `flow "${sample.flow}" reads no input at all, so the fixture supplies nothing`,
    );
    if (keys.length === 0) {
      // A `{{input}}` flow interpolates the text verbatim, so the fixture is the
      // prose itself; there are no fields to check it against.
      assert.equal(
        typeof sample.input,
        "string",
        `flow "${sample.flow}" reads the whole input, so its sample must be a string`,
      );
      assert.ok(
        (sample.input as string).trim().length > 0,
        `sample for "${sample.flow}" supplies an empty input`,
      );
      continue;
    }
    assert.equal(
      typeof sample.input === "object" && sample.input !== null && !Array.isArray(sample.input),
      true,
      `sample for "${sample.flow}" must be a JSON object`,
    );
    const supplied = sample.input as Record<string, unknown>;
    for (const key of keys) {
      assert.ok(
        Object.prototype.hasOwnProperty.call(supplied, key),
        `sample for "${sample.flow}" does not supply "${key}"`,
      );
      assert.notEqual(supplied[key], "", `sample for "${sample.flow}" supplies an empty "${key}"`);
    }
  }
});

/*
  What actually goes on the wire. `POST /flows/run` takes one string, and the
  two fixture shapes reach it differently: serializing a `{{input}}` brief would
  hand the model a quoted string with its own escapes in it, and *not*
  serializing a keyed body would leave every `{{input.<key>}}` empty.
*/
test("a sample's input reaches the runtime in the shape its flow reads", () => {
  const github = crewSampleRun("github-experts")!;
  assert.equal(crewSampleInputText(github), JSON.stringify(github.input));
  assert.deepEqual(JSON.parse(crewSampleInputText(github)), github.input);

  const content = crewSampleRun("content-studio")!;
  assert.equal(crewSampleInputText(content), content.input);
  assert.ok(!crewSampleInputText(content).startsWith('"'));
});

test("flowReadsWholeInput tells the two shapes apart", () => {
  const whole = flow("t", "t").model("a", { prompt: "Brief: {{input}}", next: null }).build();
  const keyed = flow("t", "t").model("a", { prompt: "PR {{input.number}}", next: null }).build();
  assert.equal(flowReadsWholeInput(whole), true);
  assert.equal(flowReadsWholeInput(keyed), false);
  assert.deepEqual(flowInputKeys(keyed), ["number"]);
});

test("every sample's flow has an owning seat in its blueprint", () => {
  for (const sample of crewSampleRuns) {
    const bp = getCrewBlueprint(sample.blueprint)!;
    const owner = crewFlowOwner(bp, sample.flow);
    assert.ok(owner, `no seat in "${sample.blueprint}" runs "${sample.flow}"`);
    assert.ok(owner.charter, `owning seat "${owner.id}" has no charter`);
  }
});

/*
  A sample is only useful if the checklist can tell the operator what to wire
  first, and the answer has to come off the flow rather than a hand-written
  list that would go stale one commit after the flow gained a connector call.
*/
test("sample requirements are read off the flow's own steps", () => {
  const sample = crewSampleRun("github-experts");
  assert.ok(sample);
  const needs = crewSampleNeeds(sample);
  assert.deepEqual(needs, { model: true, connectors: ["github"] });

  const bp = getCrewBlueprint("github-experts")!;
  for (const id of needs!.connectors) {
    assert.ok(
      bp.connectors.some((c) => c.id === id),
      `flow calls connector "${id}" the blueprint does not declare`,
    );
  }
});

/*
  The second certified path, and the reason it is a different shape rather than
  a second GitHub crew: its first run calls nothing outside LaCrew, so the
  checklist's connector step reports *not needed*. A suite where every fixture
  wanted a connector would never exercise that answer on the surface operators
  read.
*/
test("the content-studio sample needs a model and no connector", () => {
  const sample = crewSampleRun("content-studio");
  assert.ok(sample);
  assert.deepEqual(crewSampleNeeds(sample), { model: true, connectors: [] });

  const bp = getCrewBlueprint("content-studio")!;
  const owner = crewFlowOwner(bp, sample.flow);
  assert.equal(owner?.id, "editor-manager");
});

/*
  The thesis the fixture exists to demonstrate, read off the blueprint rather
  than asserted in prose: the flow's publish gate points at a target its own
  blueprint leaves off the whitelist, so the certified first run can only be
  refused there.
*/
test("the content-studio sample's write path aims at an unadmitted target", () => {
  const bp = getCrewBlueprint("content-studio")!;
  const publish = bp.targets.find((t) => t.id === "publish-endpoint");
  assert.ok(publish, "the blueprint no longer declares a publishing endpoint");
  assert.equal(publish.whitelisted, false);

  const def = getFlowTemplate(crewSampleRun("content-studio")!.flow)!.definition;
  const checks = def.steps.filter((s) => s.kind === "tool" && s.tool === "lacrew_check_policy");
  assert.equal(checks.length, 1, "the flow no longer asks policy before publishing");
  assert.ok(JSON.stringify(checks[0]).includes("{{target.publish-endpoint}}"));
});

/*
  The third shape (F2.25 / #114): a certified run whose principal is not the
  principal that reaches the money. The scanner starts it and the executor
  finishes it, so an operator firing this fixture sees the delegation before
  they see a trade — which is the desk's actual structure and not a detail of
  the flow.
*/
test("the defi-desk sample runs as the scanner and hands the trade down", () => {
  const sample = crewSampleRun("defi-desk");
  assert.ok(sample);
  // Model work only. Every venue read the desk declares a connector for is
  // still context an operator supplies, so this path's checklist reaches the
  // connector step's *not needed* answer rather than sending them to wire one.
  assert.deepEqual(crewSampleNeeds(sample), { model: true, connectors: [] });

  const bp = getCrewBlueprint("defi-desk")!;
  assert.equal(crewFlowOwner(bp, sample.flow)?.id, "scanner");

  const def = getFlowTemplate(sample.flow)!.definition;
  assert.deepEqual(crewFlowDelegates(def), ["desk-execute-trade"]);
  assert.ok(
    bp.flows.includes("desk-execute-trade"),
    "the blueprint must ship the flow its certified run delegates to",
  );
});

/*
  The thesis the fixture exists to demonstrate, read off the blueprint and the
  template rather than asserted in prose. Two halves, and the second is the one
  that would rot quietly: the scanner holds no propose tool at all, and the size
  the handoff proposes is the executor's own cap — so a trade at clip size is
  the largest one this path can take without the risk manager, and the seat that
  screened it could not have taken it at any size.
*/
test("the defi-desk sample's scanner cannot spend, and the handoff proposes at the clip size", () => {
  const bp = getCrewBlueprint("defi-desk")!;
  const scanner = bp.roles.find((r) => r.id === "scanner")!;
  const executor = bp.roles.find((r) => r.id === "executor")!;

  assert.ok(
    !(scanner.tools ?? []).includes("lacrew_propose_intent"),
    "the scanner seat must not hold the propose tool",
  );
  assert.ok((executor.tools ?? []).includes("lacrew_propose_intent"));
  assert.ok(
    BigInt(scanner.capUsdc) < BigInt(executor.capUsdc),
    "a scanner that could carry the executor's clip size is not a scanner",
  );

  const scan = getFlowTemplate(crewSampleRun("defi-desk")!.flow)!.definition;
  const proposes = scan.steps.filter((s) => s.kind === "gate");
  assert.equal(proposes.length, 0, "the scanner's own flow no longer proposes anything");

  const trade = getFlowTemplate("desk-execute-trade")!.definition.steps.find(
    (s) => s.id === "trade",
  );
  assert.ok(trade && trade.kind === "gate");
  assert.equal(trade.value, executor.capUsdc);
  assert.equal(trade.target, "{{target.dex-router}}");
});

test("crewFlowNeeds ignores the orchestrator's own MCP surface", () => {
  const def = flow("t", "t")
    .tool("org", "lacrew_get_org_tree", {}, { next: "read" })
    .tool("read", "github.get_pull_request", { number: 1 }, { next: null })
    .build();
  assert.deepEqual(crewFlowNeeds(def), { model: false, connectors: ["github"] });
});

test("a blueprint with no certified sample returns nothing", () => {
  assert.equal(crewSampleRun("research-desk"), undefined);
  assert.equal(crewSampleRun("not-a-blueprint"), undefined);
});
