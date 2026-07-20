import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  getAddresses,
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
