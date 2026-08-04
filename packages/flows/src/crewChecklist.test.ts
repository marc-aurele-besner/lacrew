import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  crewChecklist,
  crewChecklistBlocker,
  crewChecklistComplete,
  crewChecklistProgress,
  crewSampleRefusal,
  type CrewCheck,
  type CrewCheckId,
  type CrewChecklistFacts,
} from "./crewChecklist.js";

/** Everything wired: the state a workspace reaches at the end of the golden path. */
function ready(over: Partial<CrewChecklistFacts> = {}): CrewChecklistFacts {
  return {
    seats: { total: 6, withAccount: 6 },
    runtime: { live: true },
    model: { configured: true },
    connectors: [{ id: "github", ready: true }],
    installedFlows: ["bot-pr-triage", "dep-fix-loop"],
    blueprintFlows: ["bot-pr-triage", "dep-fix-loop"],
    runs: 1,
    threadMessages: 2,
    sample: { flow: "bot-pr-triage", needs: { model: true, connectors: ["github"] } },
    ...over,
  };
}

function step(steps: CrewCheck[], id: CrewCheckId): CrewCheck {
  const hit = steps.find((s) => s.id === id);
  assert.ok(hit, `no step "${id}"`);
  return hit;
}

test("clears every step once the whole path is wired", () => {
  const steps = crewChecklist(ready());
  assert.equal(crewChecklistComplete(steps), true);
  assert.equal(crewChecklistBlocker(steps), null);
  assert.equal(crewSampleRefusal(steps), null);
  assert.deepEqual(crewChecklistProgress(steps), { done: 7, total: 7 });
});

test("an unset model key blocks, and the refusal names it", () => {
  const steps = crewChecklist(ready({ model: { configured: false } }));
  assert.equal(step(steps, "model").state, "blocked");
  assert.equal(crewChecklistBlocker(steps)?.id, "model");
  assert.match(crewSampleRefusal(steps)!, /^Model provider: No model key/);
});

test("an unregistered connector blocks and names which one to wire", () => {
  const steps = crewChecklist(ready({ connectors: [] }));
  const connector = step(steps, "connector");
  assert.equal(connector.state, "blocked");
  assert.equal(connector.subject, "github");
  assert.match(connector.detail, /github is not registered/);
});

test("a registered connector with no credential is its own blocker", () => {
  const steps = crewChecklist(ready({ connectors: [{ id: "github", ready: false }] }));
  assert.equal(step(steps, "connector").state, "blocked");
  assert.match(step(steps, "connector").detail, /credential is not set/);
});

/*
  The distinction the module turns on. An unreadable probe is not an outage:
  rendered as blocked it sends an operator to fix a connector that is fine, and
  refusing the run on it would make a flaky read into a stall.
*/
test("an unreadable probe is unknown, and does not block the run", () => {
  const steps = crewChecklist(ready({ connectors: null, runtime: null, model: null }));
  assert.equal(step(steps, "connector").state, "unknown");
  assert.equal(step(steps, "orchestrator").state, "unknown");
  assert.equal(step(steps, "model").state, "unknown");
  assert.equal(crewChecklistBlocker(steps), null);
  assert.equal(crewSampleRefusal(steps), null);
  // Unknown is not satisfied either, so the crew is not reported as working.
  assert.equal(crewChecklistComplete(steps), false);
});

test("having run nothing is never a reason to refuse the first run", () => {
  const steps = crewChecklist(ready({ runs: 0, threadMessages: 0 }));
  assert.equal(step(steps, "run").state, "blocked");
  assert.equal(step(steps, "thread").state, "blocked");
  assert.equal(crewChecklistBlocker(steps), null);
  assert.equal(crewSampleRefusal(steps), null);
});

test("a sample that makes no model call marks the model optional", () => {
  const steps = crewChecklist(
    ready({
      model: { configured: false },
      sample: { flow: "merge-window-digest", needs: { model: false, connectors: [] } },
    }),
  );
  assert.equal(step(steps, "model").state, "optional");
  assert.equal(step(steps, "connector").state, "optional");
  assert.equal(crewChecklistComplete(steps), true);
});

test("flows waiting on a hire say so rather than pointing at an install button", () => {
  const steps = crewChecklist(ready({ seats: { total: 6, withAccount: 0 }, installedFlows: [] }));
  assert.match(step(steps, "flows").detail, /cannot be installed until at least one hire/);
  // Seats come first, so that is the one thing to fix.
  assert.equal(crewChecklistBlocker(steps)?.id, "seats");
});

/*
  A crew nobody installed from a blueprint still has seats, a runtime and a
  model key, and every one of those is checkable. What it does not have is a
  certified flow or a certified input, and the copy has to say that rather than
  report a blueprint that ships nothing.
*/
test("a hand-built crew gets a reduced checklist, not an invented one", () => {
  const steps = crewChecklist(
    ready({ blueprint: false, blueprintFlows: [], sample: null, runs: 0 }),
  );
  assert.equal(step(steps, "flows").state, "optional");
  assert.match(step(steps, "flows").detail, /came from no blueprint/);
  assert.match(step(steps, "run").detail, /crew built by hand ships no certified sample/);
  assert.equal(step(steps, "connector").state, "optional");
});
