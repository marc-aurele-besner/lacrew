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

test("explains cap escalation with numbers and shows both asset sides", () => {
  const sim = simulateIntentAction({
    agent: "0x3333333333333333333333333333333333333333",
    target: "0x4444444444444444444444444444444444444444",
    value: 75n * 10n ** 6n,
    verdict: "ESCALATE",
    allowanceCap: 50n * 10n ** 6n,
    allowanceBalance: 100n * 10n ** 6n,
    whitelisted: true,
  });
  assert.equal(sim.status, "warning");
  assert.ok(sim.warnings[0]?.includes("exceeds the agent's 50.00 USDC cap"));
  assert.equal(sim.assetChanges.length, 2);
  assert.equal(sim.assetChanges[0]?.direction, "out");
  assert.equal(sim.assetChanges[1]?.direction, "in");
  assert.ok(sim.assetChanges[1]?.delta.startsWith("+75"));
});

test("flags non-whitelisted targets", () => {
  const sim = simulateIntentAction({
    agent: "0x3333333333333333333333333333333333333333",
    target: "0x9999999999999999999999999999999999999999",
    value: 10n * 10n ** 6n,
    verdict: "ESCALATE",
    whitelisted: false,
  });
  assert.ok(sim.warnings[0]?.includes("not whitelisted"));
});

test("overdraft beyond allowance balance marks revert", () => {
  const sim = simulateIntentAction({
    agent: "0x3333333333333333333333333333333333333333",
    target: "0x4444444444444444444444444444444444444444",
    value: 500n * 10n ** 6n,
    verdict: "ESCALATE",
    allowanceBalance: 100n * 10n ** 6n,
  });
  assert.equal(sim.status, "revert");
  assert.ok(sim.warnings.some((w) => w.includes("cannot cover")));
});

