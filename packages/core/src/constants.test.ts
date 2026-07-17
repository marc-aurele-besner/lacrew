import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getAddresses, ANVIL_CHAIN_ID, SEPOLIA_CHAIN_ID } from "./constants.js";

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
});
