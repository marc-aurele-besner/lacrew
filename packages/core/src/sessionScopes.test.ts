import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  SESSION_SCOPES,
  SESSION_SCOPE_BIT,
  isSessionScope,
  narrowScopesForEscalation,
  sessionScopeMask,
  sessionScopesFromMask,
  policyForcesEscalation,
  type EscalationProofContext,
  type PolicyModuleInfo,
} from "./types.js";

/** A spend cap whose `capOf` for the queried node is `cap`. */
function spendCap(cap: string): PolicyModuleInfo {
  return { address: "0x00000000000000000000000000000000000000c1", kind: "spend_cap", cap };
}

function stackOf(...modules: PolicyModuleInfo[]): PolicyModuleInfo {
  return { address: "0x00000000000000000000000000000000000000e5", kind: "stack", modules };
}

/** Fixed clock; tests that care about the window state set it explicitly. */
const NOW = 1_800_000_000;

function ctx(over: Partial<EscalationProofContext> = {}): EscalationProofContext {
  return { value: 0n, nowSec: NOW, rateWindowMarginSec: 60, ...over };
}

/** A rate limit of `maxActions` per hour, with the node's usage against it. */
function rateLimit(opts: {
  maxActions?: number;
  windowSeconds?: number;
  windowStartSec?: number;
  actionsUsed?: number;
}): PolicyModuleInfo {
  return {
    address: "0x00000000000000000000000000000000000000ra",
    kind: "rate_limit",
    maxActions: 10,
    windowSeconds: 3600,
    ...opts,
  };
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

describe("policyForcesEscalation — spend cap", () => {
  it("is proven when the value exceeds the cap the node is checked against", () => {
    assert.equal(policyForcesEscalation([spendCap("50")], ctx({ value: 75n })), true);
  });

  it("is not proven at or under the cap — that is the ALLOW path", () => {
    assert.equal(policyForcesEscalation([spendCap("50")], ctx({ value: 50n })), false);
    assert.equal(policyForcesEscalation([spendCap("50")], ctx({ value: 10n })), false);
  });

  it("finds a cap nested inside a stack, which the router enforces just as hard", () => {
    assert.equal(policyForcesEscalation([stackOf(spendCap("50"))], ctx({ value: 75n })), true);
  });

  it("needs only one over-cap module, since any ESCALATE dominates the stack", () => {
    const modules = [spendCap("1000"), spendCap("50")];
    assert.equal(policyForcesEscalation(modules, ctx({ value: 75n })), true);
  });

  it("is unaffected by modules it cannot classify — they can only restrict further", () => {
    const unknown: PolicyModuleInfo = {
      address: "0x00000000000000000000000000000000000000ff",
      kind: "unknown",
    };
    assert.equal(policyForcesEscalation([unknown, spendCap("50")], ctx({ value: 75n })), true);
    assert.equal(policyForcesEscalation([unknown], ctx({ value: 75n })), false);
  });

  it("reports 'not proven' when there is no cap to read", () => {
    assert.equal(policyForcesEscalation([], ctx({ value: 75n })), false);
    assert.equal(
      policyForcesEscalation(
        [{ address: "0x00000000000000000000000000000000000000c1", kind: "spend_cap" }],
        ctx({ value: 75n }),
      ),
      false,
    );
  });

  it("treats an unparseable cap as unread rather than as zero", () => {
    // Zero would claim every call escalates, and narrow a key that must settle.
    assert.equal(policyForcesEscalation([spendCap("unlimited")], ctx({ value: 75n })), false);
  });
});

describe("policyForcesEscalation — rate limit", () => {
  it("is proven once the allowance is spent inside a live window", () => {
    const spent = rateLimit({ windowStartSec: NOW - 600, actionsUsed: 10 });
    assert.equal(policyForcesEscalation([spent], ctx()), true);
  });

  it("is not proven while allowance remains", () => {
    const partly = rateLimit({ windowStartSec: NOW - 600, actionsUsed: 9 });
    assert.equal(policyForcesEscalation([partly], ctx()), false);
  });

  it("is not proven before the node has ever proposed", () => {
    // windowStart 0 hits the contract's first branch, which allows.
    assert.equal(
      policyForcesEscalation([rateLimit({ windowStartSec: 0, actionsUsed: 0 })], ctx()),
      false,
    );
  });

  it("is not proven once the window has lapsed — check() starts a fresh one", () => {
    const lapsed = rateLimit({ windowStartSec: NOW - 3601, actionsUsed: 10 });
    assert.equal(policyForcesEscalation([lapsed], ctx()), false);
  });

  it("refuses to bet on a window about to lapse", () => {
    // 30s left, 60s margin: the propose could be mined after the reset, and a
    // narrowed key would then revert a call the policy allows.
    const nearlyOver = rateLimit({ windowStartSec: NOW - 3570, actionsUsed: 10 });
    assert.equal(policyForcesEscalation([nearlyOver], ctx()), false);
    // With no margin demanded, the same state is proof.
    assert.equal(policyForcesEscalation([nearlyOver], ctx({ rateWindowMarginSec: 0 })), true);
  });

  it("needs the usage read, not just the module's limits", () => {
    // Limits without per-node state cannot decide anything.
    assert.equal(policyForcesEscalation([rateLimit({})], ctx()), false);
  });

  it("escalates on the rate limit even when the value is inside the cap", () => {
    // This is the whole point: a spend the cap would ALLOW still escalates once
    // the agent has burned its allowance, so that key needs no settlement bit.
    const stack = [spendCap("50"), rateLimit({ windowStartSec: NOW - 60, actionsUsed: 10 })];
    assert.equal(policyForcesEscalation(stack, ctx({ value: 10n })), true);
  });

  it("finds a rate limit nested in a stack", () => {
    const nested = stackOf(rateLimit({ windowStartSec: NOW - 60, actionsUsed: 10 }));
    assert.equal(policyForcesEscalation([nested], ctx({ value: 10n })), true);
  });
});

/**
 * The two DENY modules are deliberately not consulted: `PolicyStack.check`
 * short-circuits on DENY and `proposeIntent` reverts on it, so such a call never
 * reaches a scope check and there is no key to narrow.
 */
describe("policyForcesEscalation — modules that DENY rather than escalate", () => {
  it("ignores a whitelist, whose miss reverts the propose instead", () => {
    const whitelist: PolicyModuleInfo = {
      address: "0x00000000000000000000000000000000000000w1",
      kind: "whitelist",
      allowedTargets: [],
    };
    assert.equal(policyForcesEscalation([whitelist], ctx({ value: 75n })), false);
  });

  it("ignores a time window, for the same reason", () => {
    const window: PolicyModuleInfo = {
      address: "0x00000000000000000000000000000000000000t1",
      kind: "time_window",
      startSecondOfDay: 0,
      endSecondOfDay: 1,
    };
    assert.equal(policyForcesEscalation([window], ctx({ value: 75n })), false);
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
