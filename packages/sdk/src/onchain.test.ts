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

describe("node policy read-back (F2.5)", () => {
  it(
    "reads each node's bound stack with classified modules and real params",
    { skip: !rpc || !anvilDeployment?.worker },
    async () => {
      const addresses = anvilDeployment!;
      const client = createOnchainClient({
        transport: http(rpc!),
        chainId: ANVIL_CHAIN_ID,
        addresses,
      });
      const policies = await client.getNodePolicies();
      assert.ok(policies.length >= 3, "root + manager + worker at minimum");

      // The worker's per-node override is the deploy's 4-module stack:
      // [timeWindow, whitelist, spendCap, rateLimit] in check() order.
      const worker = policies.find(
        (p) => p.node.toLowerCase() === addresses.worker!.toLowerCase(),
      );
      assert.ok(worker);
      assert.equal(worker.source, "node");
      assert.equal(worker.policyModule.toLowerCase(), addresses.policyStack!.toLowerCase());
      assert.deepEqual(
        worker.modules.map((m) => m.kind),
        ["time_window", "whitelist", "spend_cap", "rate_limit"],
      );

      // Params come from the chain, not a fixture: DeployMockOrg's values.
      const [window, whitelist, cap, rate] = worker.modules;
      assert.equal(cap!.defaultCap, (50n * 10n ** 6n).toString());
      assert.equal(cap!.cap, (50n * 10n ** 6n).toString());
      assert.equal(cap!.capIsExplicit, false);
      assert.equal(rate!.maxActions, 10);
      assert.equal(rate!.windowSeconds, 3600);
      assert.equal(typeof window!.startSecondOfDay, "number");
      assert.ok(
        whitelist!.allowedTargets!.some(
          (t) => t.toLowerCase() === addresses.x402Target!.toLowerCase(),
        ),
        "whitelist targets include the deploy's x402 target",
      );

      // The manager's stack drops rate limit + time window and carries an
      // explicit 200 USDC cap.
      const manager = policies.find(
        (p) => p.node.toLowerCase() === addresses.manager!.toLowerCase(),
      );
      assert.ok(manager);
      assert.deepEqual(
        manager.modules.map((m) => m.kind),
        ["whitelist", "spend_cap"],
      );
      const managerCap = manager.modules.find((m) => m.kind === "spend_cap");
      assert.equal(managerCap!.cap, (200n * 10n ** 6n).toString());
      assert.equal(managerCap!.capIsExplicit, true);

      // The root has no override: it inherits the router default, and the
      // read says so rather than presenting the fallback as a binding.
      const root = policies.find(
        (p) => p.node.toLowerCase() === addresses.humanRoot!.toLowerCase(),
      );
      assert.ok(root);
      assert.equal(root.source, "default");
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

  it(
    "reads real per-asset treasury holdings from each Treasury",
    { skip: multiAssetSkip },
    async () => {
      const client = createOnchainClient({
        transport: http(rpc!),
        chainId: ANVIL_CHAIN_ID,
        addresses: anvilDeployment!,
      });
      const balances = await client.getTreasuryBalances();
      const usdc = balances.find((b) => b.symbol === "USDC");
      const weth = balances.find((b) => b.symbol === "WETH");
      assert.ok(usdc && weth, "both asset stacks are reported");

      // Funded amounts from DeployMockOrg (TREASURY_FUND_USDC / _WETH defaults).
      // total is token.balanceOf(treasury) — streaming moves liquid→reserved but
      // never changes it, so it is stable regardless of epochs other tests ran.
      assert.equal(usdc.decimals, 6);
      assert.equal(usdc.total, 100_000n * 10n ** 6n);
      assert.equal(weth.decimals, 18);
      assert.equal(weth.total, 100n * 10n ** 18n);

      // The conservation identity each Treasury maintains: liquid = total - reserved.
      for (const b of [usdc, weth]) {
        assert.equal(b.liquid + b.reserved, b.total, `${b.symbol} liquid+reserved=total`);
      }
      // The two stacks are denominated in different tokens.
      assert.notEqual(usdc.token.toLowerCase(), weth.token.toLowerCase());
    },
  );
});

describe("agent wallet balances", () => {
  it(
    "reads each node's own native float and one row per address-book ERC-20",
    { skip: multiAssetSkip },
    async () => {
      const addresses = anvilDeployment!;
      const client = createOnchainClient({
        transport: http(rpc!),
        chainId: ANVIL_CHAIN_ID,
        addresses,
      });

      const wallets = await client.getAgentBalances();
      assert.ok(wallets.length > 0, "the deployed org has nodes");

      const worker = wallets.find(
        (w) => w.account.toLowerCase() === addresses.worker!.toLowerCase(),
      );
      assert.ok(worker, "the worker seat is reported");

      // Anvil funds its deterministic accounts, so a seat has a real float.
      // This is the number no allowance view carries: an agent with a full
      // allowance and no gas cannot transact.
      assert.equal(worker.native.token, "native");
      assert.equal(worker.native.decimals, 18);
      assert.equal(worker.native.symbol, "ETH");
      assert.ok(worker.native.balance > 0n, "Anvil seats hold a gas float");

      // One row per stack, zero balances included — "holds no WETH" is an
      // answer, and dropping the row would read as "not checked".
      const symbols = worker.tokens.map((t) => t.symbol).sort();
      assert.deepEqual(symbols, ["USDC", "WETH"]);
      const usdc = worker.tokens.find((t) => t.symbol === "USDC")!;
      const weth = worker.tokens.find((t) => t.symbol === "WETH")!;
      assert.equal(usdc.decimals, 6);
      assert.equal(weth.decimals, 18);
      assert.notEqual(usdc.token.toLowerCase(), weth.token.toLowerCase());

      // An allowance is Treasury money reserved for the node; this is the
      // account's own balance. The worker's USDC allowance is non-zero after
      // any epoch, and its wallet balance is a different figure entirely —
      // asserting they are read from different places is the point.
      const [allowance] = await client.getAllowances(addresses.worker!);
      assert.ok(allowance, "the worker carries a USDC allowance");
      assert.equal(allowance.token.toLowerCase(), usdc.token.toLowerCase());
    },
  );
});
