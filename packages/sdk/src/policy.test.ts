import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { checkClientPolicy, defaultMockPolicy } from "./policy.js";

const worker = "0x3333333333333333333333333333333333333333" as const;
const target = "0x4444444444444444444444444444444444444444" as const;

describe("checkClientPolicy", () => {
  it("allows under-cap whitelisted spends", () => {
    const v = checkClientPolicy(defaultMockPolicy, {
      agent: worker,
      target,
      value: 40n * 10n ** 6n,
    });
    assert.equal(v, "ALLOW");
  });

  it("escalates over-cap whitelisted spends", () => {
    const v = checkClientPolicy(defaultMockPolicy, {
      agent: worker,
      target,
      value: 75n * 10n ** 6n,
    });
    assert.equal(v, "ESCALATE");
  });

  it("denies non-whitelisted targets", () => {
    const v = checkClientPolicy(defaultMockPolicy, {
      agent: worker,
      target: "0x9999999999999999999999999999999999999999",
      value: 1n,
    });
    assert.equal(v, "DENY");
  });

  it("matches agents and targets case-insensitively, as the chain compares addresses", () => {
    const v = checkClientPolicy(defaultMockPolicy, {
      agent: worker.toUpperCase().replace("0X", "0x") as `0x${string}`,
      target: target.toUpperCase().replace("0X", "0x") as `0x${string}`,
      value: 40n * 10n ** 6n,
    });
    assert.equal(v, "ALLOW");
  });

  it("an agent with no configured cap escalates any positive spend", () => {
    // The unknown-agent cap is 0, not unlimited: fail closed.
    const v = checkClientPolicy(defaultMockPolicy, {
      agent: "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd",
      target,
      value: 1n,
    });
    assert.equal(v, "ESCALATE");
  });
});
