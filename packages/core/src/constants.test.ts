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

  it("ignores malformed env overrides", () => {
    const saved = process.env.LACREW_ORG_REGISTRY;
    try {
      process.env.LACREW_ORG_REGISTRY = "not-an-address";
      const addrs = getAddresses(ANVIL_CHAIN_ID);
      assert.match(addrs.orgRegistry, /^0x[a-fA-F0-9]{40}$/);
      assert.notEqual(addrs.orgRegistry, "not-an-address");
    } finally {
      if (saved === undefined) delete process.env.LACREW_ORG_REGISTRY;
      else process.env.LACREW_ORG_REGISTRY = saved;
    }
  });
});
