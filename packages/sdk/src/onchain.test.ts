/**
 * Onchain client tests skip unless ANVIL_RPC is set (e.g. http://127.0.0.1:8545).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createOnchainClient } from "./onchain.js";
import { http } from "viem";
import { getAddresses, ANVIL_CHAIN_ID } from "@lacrew/core";

const rpc = process.env.ANVIL_RPC;

describe("createOnchainClient", () => {
  it("constructs with addresses from getAddresses", () => {
    const client = createOnchainClient({
      transport: http(rpc ?? "http://127.0.0.1:8545"),
      chainId: ANVIL_CHAIN_ID,
      addresses: getAddresses(ANVIL_CHAIN_ID),
    });
    assert.equal(client.chainId, ANVIL_CHAIN_ID);
    assert.ok(client.addresses.orgRegistry);
  });

  it(
    "reads org tree from Anvil when ANVIL_RPC is set",
    { skip: !rpc },
    async () => {
      const addresses = getAddresses(ANVIL_CHAIN_ID);
      assert.notEqual(
        addresses.orgRegistry,
        "0x0000000000000000000000000000000000000000",
      );
      const client = createOnchainClient({
        transport: http(rpc!),
        chainId: ANVIL_CHAIN_ID,
        addresses,
      });
      const tree = await client.getOrgTree();
      assert.ok(tree.length >= 1);
      assert.equal(tree[0]?.kind, "human_root");
    },
  );
});
