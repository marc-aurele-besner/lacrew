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
});
