import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  SESSION_SCOPES,
  SESSION_SCOPE_BIT,
  isSessionScope,
  narrowScopesForEscalation,
  sessionScopeMask,
  sessionScopesFromMask,
  spendCapForcesEscalation,
  type PolicyModuleInfo,
} from "./types.js";

/** A spend cap whose `capOf` for the queried node is `cap`. */
function spendCap(cap: string): PolicyModuleInfo {
  return { address: "0x00000000000000000000000000000000000000c1", kind: "spend_cap", cap };
}

function stackOf(...modules: PolicyModuleInfo[]): PolicyModuleInfo {
  return { address: "0x00000000000000000000000000000000000000e5", kind: "stack", modules };
}

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

describe("spendCapForcesEscalation", () => {
  it("is proven when the value exceeds the cap the node is checked against", () => {
    assert.equal(spendCapForcesEscalation([spendCap("50")], 75n), true);
  });

  it("is not proven at or under the cap — that is the ALLOW path", () => {
    assert.equal(spendCapForcesEscalation([spendCap("50")], 50n), false);
    assert.equal(spendCapForcesEscalation([spendCap("50")], 10n), false);
  });

  it("finds a cap nested inside a stack, which the router enforces just as hard", () => {
    assert.equal(spendCapForcesEscalation([stackOf(spendCap("50"))], 75n), true);
  });

  it("needs only one over-cap module, since any ESCALATE dominates the stack", () => {
    const modules = [spendCap("1000"), spendCap("50")];
    assert.equal(spendCapForcesEscalation(modules, 75n), true);
  });

  it("is unaffected by modules it cannot classify — they can only restrict further", () => {
    const unknown: PolicyModuleInfo = {
      address: "0x00000000000000000000000000000000000000ff",
      kind: "unknown",
    };
    assert.equal(spendCapForcesEscalation([unknown, spendCap("50")], 75n), true);
    assert.equal(spendCapForcesEscalation([unknown], 75n), false);
  });

  it("reports 'not proven' when there is no cap to read", () => {
    assert.equal(spendCapForcesEscalation([], 75n), false);
    assert.equal(
      spendCapForcesEscalation(
        [{ address: "0x00000000000000000000000000000000000000c1", kind: "spend_cap" }],
        75n,
      ),
      false,
    );
  });

  it("treats an unparseable cap as unread rather than as zero", () => {
    // Zero would claim every call escalates, and narrow a key that must settle.
    assert.equal(spendCapForcesEscalation([spendCap("unlimited")], 75n), false);
  });
});

describe("narrowScopesForEscalation", () => {
  const full: readonly ("propose:intent" | "spend:whitelist")[] = [
    "propose:intent",
    "spend:whitelist",
  ];

  it("drops settlement authority the escalating call cannot use", () => {
    assert.deepEqual(narrowScopesForEscalation(full, true), ["propose:intent"]);
  });

  it("leaves the standing scopes alone when escalation is not proven", () => {
    assert.deepEqual(narrowScopesForEscalation(full, false), [...full]);
  });

  it("never widens: the result is always a subset of what the agent had", () => {
    assert.deepEqual(narrowScopesForEscalation(["propose:intent"], true), ["propose:intent"]);
    assert.deepEqual(narrowScopesForEscalation(["propose:intent"], false), ["propose:intent"]);
  });

  it("refuses to narrow to an empty mask, which is refused at issue anyway", () => {
    assert.deepEqual(narrowScopesForEscalation(["spend:whitelist"], true), ["spend:whitelist"]);
  });

  it("returns a copy, so a caller cannot mutate the standing policy through it", () => {
    const standing: ("propose:intent" | "spend:whitelist")[] = ["propose:intent"];
    narrowScopesForEscalation(standing, false).push("spend:whitelist");
    assert.deepEqual(standing, ["propose:intent"]);
  });
});
