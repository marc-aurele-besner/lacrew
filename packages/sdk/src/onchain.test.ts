/**
 * Onchain client tests skip unless ANVIL_RPC is set (e.g. http://127.0.0.1:8545).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createOnchainClient } from "./onchain.js";
import { http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { getAddresses, ANVIL_CHAIN_ID } from "@lacrew/core";

const rpc = process.env.ANVIL_RPC;

// Anvil deterministic accounts 0 and 8 — used only to construct wallet clients;
// no network is touched by these constructor assertions.
const MAIN = privateKeyToAccount(
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
);
const ISSUER = privateKeyToAccount(
  "0xdbda1821b80551c9d65939329250298aa3472ba22feea921c0cf5d620ea67b97",
);

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

  it("issuance falls back to the main account when no issuerAccount is given", () => {
    const client = createOnchainClient({
      transport: http("http://127.0.0.1:8545"),
      account: MAIN,
      chainId: ANVIL_CHAIN_ID,
      addresses: getAddresses(ANVIL_CHAIN_ID),
    });
    assert.equal(
      client.issuerWalletClient?.account?.address,
      client.walletClient?.account?.address,
    );
  });

  it("signs issuance with a distinct issuerAccount when given one", () => {
    const client = createOnchainClient({
      transport: http("http://127.0.0.1:8545"),
      account: MAIN,
      issuerAccount: ISSUER,
      chainId: ANVIL_CHAIN_ID,
      addresses: getAddresses(ANVIL_CHAIN_ID),
    });
    assert.equal(client.issuerWalletClient?.account?.address, ISSUER.address);
    assert.notEqual(
      client.issuerWalletClient?.account?.address,
      client.walletClient?.account?.address,
    );
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
