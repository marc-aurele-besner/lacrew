import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  SESSION_SCOPES,
  SESSION_SCOPE_BIT,
  isSessionScope,
  sessionScopeMask,
  sessionScopesFromMask,
} from "./types.js";

describe("session scopes", () => {
  it("encodes each known scope to its own bit", () => {
    assert.equal(sessionScopeMask(["propose:intent"]), 1n);
    assert.equal(sessionScopeMask(["spend:whitelist"]), 2n);
    assert.equal(sessionScopeMask(["propose:intent", "spend:whitelist"]), 3n);
  });

  it("is order-insensitive", () => {
    assert.equal(
      sessionScopeMask(["spend:whitelist", "propose:intent"]),
      sessionScopeMask(["propose:intent", "spend:whitelist"]),
    );
  });

  it("round-trips through a mask", () => {
    for (const scope of SESSION_SCOPES) {
      assert.deepEqual(sessionScopesFromMask(sessionScopeMask([scope])), [scope]);
    }
    assert.deepEqual(sessionScopesFromMask(3n), ["propose:intent", "spend:whitelist"]);
  });

  it("has no scope left over the mask cannot express", () => {
    assert.deepEqual(
      sessionScopesFromMask(sessionScopeMask(SESSION_SCOPES)).sort(),
      SESSION_SCOPES.slice().sort(),
    );
  });

  /**
   * Dropping an unknown scope would issue a key with less authority than asked
   * for, and the failure would land far from the typo that caused it.
   */
  it("throws on an unknown scope rather than silently dropping it", () => {
    assert.throws(() => sessionScopeMask(["propose:intent", "spend:everything"]), {
      message: /unknown session scope "spend:everything"/,
    });
  });

  it("encodes nothing as an empty mask, which the registry rejects", () => {
    assert.equal(sessionScopeMask([]), 0n);
  });

  it("ignores bits outside the vocabulary when decoding", () => {
    assert.deepEqual(sessionScopesFromMask(1n | (1n << 200n)), ["propose:intent"]);
  });

  it("guards scope strings", () => {
    assert.equal(isSessionScope("propose:intent"), true);
    assert.equal(isSessionScope("spend_cap:50"), false);
  });

  /** The bits are a contract with SessionRegistry.SCOPE_*, not an internal detail. */
  it("pins the bit positions the contract expects", () => {
    assert.deepEqual(SESSION_SCOPE_BIT, {
      "propose:intent": 1,
      "spend:whitelist": 2,
    });
  });
});
