/**
 * DelegationProvider tests. Guards run everywhere; the lifecycle test needs
 * the canonical Delegation Toolkit contracts, so it skips unless MM_FORK_RPC
 * points at an anvil fork of Base mainnet:
 *
 *   anvil --port 8546 --fork-url https://mainnet.base.org
 *   MM_FORK_RPC=http://127.0.0.1:8546 MM_FORK_PK=<an anvil dev key> \
 *     pnpm --filter @lacrew/adapter-wallet-metamask test
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { createPublicClient, createWalletClient, defineChain, http, parseEther } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { createMetaMaskDelegationProvider } from "./sessionDelegation.js";
import { buildRedeemTx, nativeTransferExecution } from "./delegation.js";
import type { Delegation } from "./delegation.js";

const rpc = process.env.MM_FORK_RPC;
const pk = process.env.MM_FORK_PK;
const skipChain = !rpc || !pk;

test("the provider refuses unsupported chains outright", () => {
  assert.throws(
    () =>
      createMetaMaskDelegationProvider({
        rpcUrl: "http://127.0.0.1:8545",
        chainId: 31337,
        owner: privateKeyToAccount(generatePrivateKey()),
      }),
    /unsupported on chain 31337/,
  );
});

test("a non-positive budget is refused before touching the chain", async () => {
  const provider = createMetaMaskDelegationProvider({
    rpcUrl: "http://127.0.0.1:8545",
    chainId: 8453,
    owner: privateKeyToAccount(generatePrivateKey()),
  });
  await assert.rejects(
    () =>
      provider.issue({
        agent: "0x1111111111111111111111111111111111111111",
        sessionKey: "0x2222222222222222222222222222222222222222",
        maxValue: 0n,
        expiresAtSec: Math.floor(Date.now() / 1000) + 3600,
      }),
    /budget must be positive/,
  );
});

test(
  "fork: issue → deploy seat → redeem in budget → over-budget reverts → revoke kills it",
  { skip: skipChain },
  async () => {
    const chain = defineChain({
      id: 8453,
      name: "mm-fork",
      nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
      rpcUrls: { default: { http: [rpc!] } },
    });
    const client = createPublicClient({ chain, transport: http(rpc!) });
    // Fresh keys per run: anvil defaults carry EIP-7702 delegations on real Base.
    const owner = privateKeyToAccount(generatePrivateKey());
    const sessionKey = privateKeyToAccount(generatePrivateKey());
    const funder = privateKeyToAccount(pk as `0x${string}`);
    const fw = createWalletClient({ account: funder, chain, transport: http(rpc!) });
    for (const to of [owner.address, sessionKey.address]) {
      await client.waitForTransactionReceipt({
        hash: await fw.sendTransaction({ to, value: parseEther("1") }),
      });
    }
    const ow = createWalletClient({ account: owner, chain, transport: http(rpc!) });
    const sw = createWalletClient({ account: sessionKey, chain, transport: http(rpc!) });

    const provider = createMetaMaskDelegationProvider({
      rpcUrl: rpc!,
      chainId: 8453,
      owner,
    });
    const agent = `0xa9${owner.address.slice(4)}` as `0x${string}`;

    // Issue: the seat is counterfactual, so a deploy tx rides along.
    const issued = await provider.issue({
      agent,
      sessionKey: sessionKey.address,
      maxValue: parseEther("0.5"),
      expiresAtSec: Math.floor(Date.now() / 1000) + 3600,
    });
    assert.equal(issued.delegation.seatDeployed, false);
    assert.ok(issued.seatDeployTx, "an undeployed seat ships its deploy tx");
    assert.equal(issued.delegation.budget.kind, "nativeTotal");
    assert.equal(issued.delegation.budget.amount, parseEther("0.5").toString());

    // Root broadcasts the deploy and funds the seat.
    await client.waitForTransactionReceipt({
      hash: await ow.sendTransaction({
        to: issued.seatDeployTx!.to,
        data: issued.seatDeployTx!.data,
        value: issued.seatDeployTx!.value,
      }),
    });
    await client.waitForTransactionReceipt({
      hash: await fw.sendTransaction({ to: issued.delegation.seat, value: parseEther("1") }),
    });

    // Re-issuing against the now-deployed seat carries no deploy tx.
    const again = await provider.issue({
      agent,
      sessionKey: sessionKey.address,
      maxValue: parseEther("0.5"),
      expiresAtSec: Math.floor(Date.now() / 1000) + 3600,
    });
    assert.equal(again.delegation.seatDeployed, true);
    assert.equal(again.seatDeployTx, undefined);
    assert.equal(again.delegation.seat, issued.delegation.seat);

    // The session key redeems within budget…
    const redeem = await buildRedeemTx(
      8453,
      issued.delegation.signed as Delegation,
      nativeTransferExecution(sessionKey.address, parseEther("0.3")),
    );
    const r1 = await client.waitForTransactionReceipt({
      hash: await sw.sendTransaction({ to: redeem.to, data: redeem.data, value: 0n }),
    });
    assert.equal(r1.status, "success");

    // …and cannot exceed it (0.3 spent of 0.5; 0.3 more breaches the cap).
    const over = await buildRedeemTx(
      8453,
      issued.delegation.signed as Delegation,
      nativeTransferExecution(sessionKey.address, parseEther("0.3")),
    );
    await assert.rejects(() =>
      sw.sendTransaction({ to: over.to, data: over.data, value: 0n }),
    );

    // Revoke: one plain root transaction (self-bundled handleOps), then the
    // remaining budget is unreachable.
    const revoke = await provider.buildRevokeTx(issued.delegation, owner.address);
    const r2 = await client.waitForTransactionReceipt({
      hash: await ow.sendTransaction({ to: revoke.to, data: revoke.data, value: revoke.value }),
    });
    assert.equal(r2.status, "success");
    const after = await buildRedeemTx(
      8453,
      issued.delegation.signed as Delegation,
      nativeTransferExecution(sessionKey.address, parseEther("0.1")),
    );
    await assert.rejects(() =>
      sw.sendTransaction({ to: after.to, data: after.data, value: 0n }),
    );
  },
);
