import { strict as assert } from "node:assert";
import { test } from "node:test";
import { getCrewBlueprint } from "./crewBlueprints.js";
import {
  crewFlowNeeds,
  crewFlowOwner,
  crewSampleNeeds,
  crewSampleRun,
  crewSampleRuns,
  flowInputKeys,
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
    assert.ok(keys.length > 0, `flow "${sample.flow}" reads no keyed input`);
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
