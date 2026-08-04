/**
 * Scenario selection for the workspace runner (F2.29).
 *
 * The filter decides what an operator's "run evals" actually runs, so the case
 * worth pinning is the empty one: a filter that matches nothing must report
 * zero, never a suite that passed by testing nothing.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { listEvalScenarios, selectEvalScenarios } from "./evalRun.js";
import { firstPartyEvals } from "./evalSuite.js";
import type { FlowEvalScenario } from "./evals.js";

const SCENARIOS = [
  { id: "a", flow: "bot-pr-triage", blueprint: "github-experts", expect: {} },
  { id: "b", flow: "merge-window-digest", blueprint: "github-experts", expect: {} },
  { id: "c", flow: "drift-alert", blueprint: "advisory-desk", expect: {} },
] as unknown as FlowEvalScenario[];

test("no filter runs everything", () => {
  assert.equal(selectEvalScenarios(SCENARIOS, {}).length, 3);
});

test("a blueprint filter selects that desk's scenarios", () => {
  assert.deepEqual(
    selectEvalScenarios(SCENARIOS, { blueprint: "github-experts" }).map((s) => s.id),
    ["a", "b"],
  );
});

test("a flow filter selects the scenarios that run it", () => {
  assert.deepEqual(
    selectEvalScenarios(SCENARIOS, { flow: "drift-alert" }).map((s) => s.id),
    ["c"],
  );
});

test("ids select exactly those, in suite order", () => {
  assert.deepEqual(
    selectEvalScenarios(SCENARIOS, { ids: ["c", "a"] }).map((s) => s.id),
    ["a", "c"],
  );
});

test("a filter matching nothing selects nothing rather than everything", () => {
  // The failure this guards: a filter that fell through to "no constraint"
  // would report a green suite that ran somebody else's scenarios.
  assert.deepEqual(selectEvalScenarios(SCENARIOS, { flow: "no-such-flow" }), []);
  assert.deepEqual(selectEvalScenarios(SCENARIOS, { ids: ["nope"] }), []);
});

test("an inline definition is filterable by its own id", () => {
  const inline = [
    { id: "inline", definition: { id: "custom-flow", name: "Custom", steps: [] }, expect: {} },
  ] as unknown as FlowEvalScenario[];
  assert.equal(selectEvalScenarios(inline, { flow: "custom-flow" }).length, 1);
});

test("the listing carries what a surface offers, and nothing heavier", () => {
  const listed = listEvalScenarios(firstPartyEvals);
  assert.ok(listed.length > 0);
  for (const entry of listed) {
    assert.ok(entry.id);
    // Mocks and expectations are the suite's business, not a listing's.
    assert.deepEqual(
      Object.keys(entry).filter((k) => !["id", "describe", "flow", "blueprint"].includes(k)),
      [],
    );
  }
});
