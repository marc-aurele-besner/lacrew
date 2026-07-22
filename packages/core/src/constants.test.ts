import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  getAddresses,
  hasDeployment,
  ADDRESS_ENV_VARS,
  ANVIL_CHAIN_ID,
  SEPOLIA_CHAIN_ID,
} from "./constants.js";

describe("getAddresses", () => {
  it("returns anvil deployment shape", () => {
    const addrs = getAddresses(ANVIL_CHAIN_ID);
    assert.equal(addrs.chainId, ANVIL_CHAIN_ID);
    assert.match(addrs.orgRegistry, /^0x[a-fA-F0-9]{40}$/);
  });

  it("returns Sepolia placeholder deployment", () => {
    const addrs = getAddresses(SEPOLIA_CHAIN_ID);
    assert.equal(addrs.chainId, SEPOLIA_CHAIN_ID);
    assert.match(addrs.orgRegistry, /^0x[a-fA-F0-9]{40}$/);
  });

  it("honors env overrides for every address field", () => {
    const override = "0x00000000000000000000000000000000000000AA" as const;
    const saved: Record<string, string | undefined> = {};
    try {
      for (const envVar of Object.values(ADDRESS_ENV_VARS)) {
        saved[envVar] = process.env[envVar];
        process.env[envVar] = override;
      }
      const addrs = getAddresses(ANVIL_CHAIN_ID);
      for (const field of Object.keys(ADDRESS_ENV_VARS) as Array<
        keyof typeof ADDRESS_ENV_VARS
      >) {
        assert.equal(addrs[field], override, `field ${field} should be overridable`);
      }
    } finally {
      for (const [envVar, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[envVar];
        else process.env[envVar] = value;
      }
    }
  });

  it("throws on a malformed env override instead of falling back", () => {
    const saved = process.env.LACREW_ORG_REGISTRY;
    try {
      // A typo must not resolve to the deployment address behind the caller's back.
      process.env.LACREW_ORG_REGISTRY = "not-an-address";
      assert.throws(() => getAddresses(ANVIL_CHAIN_ID), /LACREW_ORG_REGISTRY/);

      // Truncated addresses are the realistic failure — a dropped character.
      process.env.LACREW_ORG_REGISTRY = "0xCcBcac53a38c585bA0caf20dd2d906f14dac88";
      assert.throws(() => getAddresses(ANVIL_CHAIN_ID), /not a 20-byte hex address/);
    } finally {
      if (saved === undefined) delete process.env.LACREW_ORG_REGISTRY;
      else process.env.LACREW_ORG_REGISTRY = saved;
    }
  });

  it("treats an empty override as unset", () => {
    const saved = process.env.LACREW_ORG_REGISTRY;
    try {
      process.env.LACREW_ORG_REGISTRY = "";
      const addrs = getAddresses(ANVIL_CHAIN_ID);
      assert.match(addrs.orgRegistry, /^0x[a-fA-F0-9]{40}$/);
    } finally {
      if (saved === undefined) delete process.env.LACREW_ORG_REGISTRY;
      else process.env.LACREW_ORG_REGISTRY = saved;
    }
  });
});

describe("hasDeployment", () => {
  it("is true for a chain that was actually deployed to", () => {
    assert.equal(hasDeployment(ANVIL_CHAIN_ID), true);
  });

  it("is false for a chain with no deployment", () => {
    // Sepolia and Base Sepolia used to ship committed address books of
    // 0x…01 through 0x…07. They looked like deployments, satisfied every type,
    // and produced a runtime whose reads all revert — rendering as an empty org
    // rather than as a chain nobody has deployed to. The placeholders are gone;
    // this is the question a caller should ask instead.
    const prev = process.env[ADDRESS_ENV_VARS.orgRegistry];
    delete process.env[ADDRESS_ENV_VARS.orgRegistry];
    try {
      assert.equal(hasDeployment(SEPOLIA_CHAIN_ID), false);
      assert.equal(hasDeployment(999_999), false);
    } finally {
      if (prev !== undefined) process.env[ADDRESS_ENV_VARS.orgRegistry] = prev;
    }
  });

  it("counts a fully overridden local deployment", () => {
    const prev = process.env[ADDRESS_ENV_VARS.orgRegistry];
    process.env[ADDRESS_ENV_VARS.orgRegistry] = "0x1111111111111111111111111111111111111111";
    try {
      assert.equal(hasDeployment(SEPOLIA_CHAIN_ID), true);
    } finally {
      if (prev === undefined) delete process.env[ADDRESS_ENV_VARS.orgRegistry];
      else process.env[ADDRESS_ENV_VARS.orgRegistry] = prev;
    }
  });
});
