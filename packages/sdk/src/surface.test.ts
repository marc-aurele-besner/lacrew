import { describe, it } from "node:test";
import assert from "node:assert/strict";

import * as root from "./index.js";
import * as testing from "./testing/index.js";

/**
 * The package root must not hand out fabricated data.
 *
 * `createLacrewClient` answers every read with an organisation that does not
 * exist — a treasury, an allowance, an audit trail, all invented. It used to
 * sit in the root export, one plausible import away from any production code
 * path, and that is how invented numbers reached real surfaces.
 *
 * This test is the guard on that boundary. If it fails, something moved back.
 */
describe("SDK public surface", () => {
  it("does not export the test client from the package root", () => {
    assert.equal(
      "createLacrewClient" in root,
      false,
      "createLacrewClient belongs to @lacrew/sdk/testing, not the root",
    );
    assert.equal("LacrewClient" in root, false);
  });

  it("does not export demo fixtures from the package root", () => {
    for (const name of [
      "mockOrgNodes",
      "mockAllowances",
      "mockPendingIntents",
      "mockSessionKeys",
      "mockAuditTrail",
    ]) {
      assert.equal(name in root, false, `${name} must not be reachable from the root`);
    }
  });

  it("still exports the onchain client and pure helpers", () => {
    // The flip side: moving the mock must not have taken the real client with it.
    assert.equal(typeof root.createOnchainClient, "function");
    assert.equal(typeof root.simulateIntentAction, "function");
    assert.equal(typeof root.checkClientPolicy, "function");
  });

  it("keeps the test client reachable from ./testing", () => {
    assert.equal(typeof testing.createLacrewClient, "function");
    assert.ok(Array.isArray(testing.mockOrgNodes));
  });
});
