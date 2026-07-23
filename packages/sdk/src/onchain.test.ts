/**
 * Onchain client tests skip unless ANVIL_RPC is set (e.g. http://127.0.0.1:8545).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createOnchainClient } from "./onchain.js";
import { http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { getAddresses, ANVIL_CHAIN_ID, type ChainAddresses } from "@lacrew/core";

const rpc = process.env.ANVIL_RPC;

/**
 * Read the on-disk Anvil deployment (which carries `assets` only after a
 * `DEPLOY_SECOND_ASSET=1` deploy). Read from the file rather than getAddresses
 * so the multi-asset test exercises a real two-stack deployment without the
 * committed single-asset generated addresses needing to carry the extra stack.
 */
function loadAnvilDeployment(): ChainAddresses | null {
  try {
    const path = new URL(
      "../../../contracts/deployments/31337.json",
      import.meta.url,
    );
    return JSON.parse(readFileSync(path, "utf8")) as ChainAddresses;
  } catch {
    return null;
  }
}

const anvilDeployment = loadAnvilDeployment();
const wethStack = anvilDeployment?.assets?.find((a) => a.symbol === "WETH");
// Multi-asset assertions need both a live chain and a deployed second stack.
const multiAssetSkip = !rpc || !wethStack || !anvilDeployment?.worker;

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

describe("multi-asset budgeting (F0.4)", () => {
  it(
    "streams and reads a second asset independently of USDC",
    { skip: multiAssetSkip },
    async () => {
      const addresses = anvilDeployment!;
      const worker = addresses.worker!;
      const weth = wethStack!;
      const client = createOnchainClient({
        transport: http(rpc!),
        account: MAIN, // humanRoot = Anvil #0 = the EpochStreamer operator
        chainId: ANVIL_CHAIN_ID,
        addresses,
      });

      const [usdcBefore] = await client.getAllowances(worker); // primary stack
      const [wethBefore] = await client.getAllowances(worker, "WETH");
      assert.ok(usdcBefore && wethBefore);

      const { epoch } = await client.runEpoch("WETH");
      assert.ok(epoch >= 1);

      const [usdcAfter] = await client.getAllowances(worker);
      const [wethAfter] = await client.getAllowances(worker, "WETH");
      assert.ok(usdcAfter && wethAfter);

      // The WETH allowance grew by exactly one epoch's grant (1 WETH, 18 dec)...
      assert.equal(wethAfter.balance - wethBefore.balance, 10n ** 18n);
      // ...denominated in the WETH token the stack binds...
      assert.equal(wethAfter.token.toLowerCase(), weth.token.toLowerCase());
      // ...while USDC bookkeeping, read from its own treasury, did not move.
      assert.equal(usdcAfter.balance, usdcBefore.balance);
      assert.notEqual(usdcAfter.token.toLowerCase(), weth.token.toLowerCase());
    },
  );

  it(
    "rejects an unknown asset rather than budgeting the primary treasury",
    { skip: multiAssetSkip },
    async () => {
      const client = createOnchainClient({
        transport: http(rpc!),
        chainId: ANVIL_CHAIN_ID,
        addresses: anvilDeployment!,
      });
      await assert.rejects(
        () => client.getAllowances(anvilDeployment!.worker!, "DAI"),
        /No asset stack "DAI"/,
      );
    },
  );
});
