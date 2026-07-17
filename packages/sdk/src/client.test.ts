import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createLacrewClient } from "./client.js";
import { MOCK_MANAGER, MOCK_ROOT, MOCK_WORKER } from "@lacrew/core";

describe("LacrewClient resolve recursion", () => {
  it("lets a manager finalize within their cap", async () => {
    const client = createLacrewClient({ useMock: true });
    const { intentId } = await client.proposeIntent({
      agent: MOCK_WORKER,
      target: "0x4444444444444444444444444444444444444444",
      value: 75n * 10n ** 6n,
    });
    assert.notEqual(intentId, "0");

    const result = await client.resolveIntent(intentId, true, MOCK_MANAGER);
    assert.equal(result.escalated, false);
    assert.equal(result.intent.resolved, true);
    assert.equal(result.intent.approved, true);
  });

  it("climbs to root when over manager cap", async () => {
    const client = createLacrewClient({ useMock: true });
    const { intentId } = await client.proposeIntent({
      agent: MOCK_WORKER,
      target: "0x4444444444444444444444444444444444444444",
      value: 250n * 10n ** 6n,
    });

    const mid = await client.resolveIntent(intentId, true, MOCK_MANAGER);
    assert.equal(mid.escalated, true);
    assert.equal(mid.intent.resolved, false);
    assert.equal(mid.intent.awaitingApprover?.toLowerCase(), MOCK_ROOT.toLowerCase());

    const top = await client.resolveIntent(intentId, true, MOCK_ROOT);
    assert.equal(top.escalated, false);
    assert.equal(top.intent.resolved, true);
    assert.equal(top.intent.approved, true);
  });
});
