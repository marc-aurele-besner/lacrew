import assert from "node:assert/strict";
import { test } from "node:test";
import { simulateIntentAction } from "./simulate.js";

test("simulateIntentAction warns on ESCALATE", () => {
  const sim = simulateIntentAction({
    agent: "0x1111111111111111111111111111111111111111",
    target: "0x2222222222222222222222222222222222222222",
    value: 75n * 10n ** 6n,
    verdict: "ESCALATE",
  });
  assert.equal(sim.status, "warning");
  assert.ok(sim.warnings.length > 0);
  assert.equal(sim.assetChanges[0]?.direction, "out");
});

test("simulateIntentAction marks DENY as revert", () => {
  const sim = simulateIntentAction({
    agent: "0x1111111111111111111111111111111111111111",
    target: "0x2222222222222222222222222222222222222222",
    value: 1n,
    verdict: "DENY",
  });
  assert.equal(sim.status, "revert");
});
