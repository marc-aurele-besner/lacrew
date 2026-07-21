/**
 * Allowance-module tests. The chain half needs a network that already has the
 * Safe singletons and the AllowanceModule, so it skips unless SAFE_FORK_RPC is
 * set. To run the full lifecycle:
 *
 *   anvil --port 8546 --fork-url https://mainnet.base.org
 *   SAFE_FORK_RPC=http://127.0.0.1:8546 \
 *   SAFE_FORK_PK=<an anvil dev key> pnpm --filter @lacrew/adapter-wallet-safe test
 *
 * The key is read from the environment so no key material lives in the repo.
 *
 * The package runs its test files with --test-concurrency=1: every chain test
 * funds from the same owner account, and parallel files race that account's
 * nonce ("nonce too low"). Keep the flag while these tests share a signer.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createPublicClient,
  createTestClient,
  createWalletClient,
  defineChain,
  formatEther,
  http,
  parseAbi,
  parseEther,
  publicActions,
  walletActions,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  ALLOWANCE_MODULE_VERSION,
  NATIVE_TOKEN,
  buildAllowanceSetupTxs,
  buildAllowanceTransferTx,
  buildRemoveDelegateTx,
  buildSetAllowanceTx,
  deploySafeWallet,
  enableSafeModule,
  executeSafeTransactions,
  getAllowanceModuleAddress,
  isModuleEnabled,
  predictSafeWallet,
  readAllowance,
  readDelegates,
} from "./index.js";

const BASE = 8453;
const rpc = process.env.SAFE_FORK_RPC;
const pk = process.env.SAFE_FORK_PK;
const skipChain = !rpc || !pk;

/** USDC on Base — the asset an agent budget is actually denominated in. */
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as const;
/** Aave v3 Base aUSDC, used only as a faucet for the fork. */
const USDC_WHALE = "0x4e65fE4DbA92790696d040ac24Aa414708F5c0AB" as const;
const ERC20 = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function transfer(address,uint256) returns (bool)",
]);

test("resolves the pinned AllowanceModule on Base", () => {
  assert.equal(ALLOWANCE_MODULE_VERSION, "0.1.1");
  assert.equal(
    getAllowanceModuleAddress(BASE),
    "0xAA46724893dedD72658219405185Fb0Fc91e091C",
  );
});

test("an unsupported chain reports plainly instead of returning a bad address", () => {
  assert.throws(() => getAllowanceModuleAddress(31337), /not deployed on chain 31337/);
});

test("amounts beyond uint96 are rejected rather than truncated", () => {
  const delegate = "0x1111111111111111111111111111111111111111" as const;
  assert.throws(
    () => buildSetAllowanceTx(BASE, { delegate, amount: 1n << 96n }),
    /exceeds uint96/,
  );
  // The boundary itself is allowed.
  assert.ok(buildSetAllowanceTx(BASE, { delegate, amount: (1n << 96n) - 1n }));
});

test("setup builds delegate registration before the allowance", () => {
  const txs = buildAllowanceSetupTxs(BASE, {
    delegate: "0x1111111111111111111111111111111111111111",
    amount: 1_000n,
  });
  assert.equal(txs.length, 2);
  // addDelegate must land first — an allowance for an unregistered delegate is
  // unusable, and the module records them independently.
  assert.match(txs[0]!.data, /^0xe71bdf41/); // addDelegate(address)
  assert.match(txs[1]!.data, /^0xbeaeb388/); // setAllowance(...)
  assert.ok(txs.every((t) => t.to === getAllowanceModuleAddress(BASE)));
});

test(
  "a seat spends within its onchain budget and is stopped at the cap",
  { skip: skipChain, timeout: 300_000 },
  async () => {
    const owner = privateKeyToAccount(pk as `0x${string}`);
    // Fresh keys: anvil's default accounts carry EIP-7702 delegations on real
    // Base, which changes signature handling in ways unrelated to this test.
    const delegate = privateKeyToAccount(generatePrivateKey());
    const payee = privateKeyToAccount(generatePrivateKey());

    const publicClient = createPublicClient({ transport: http(rpc!) });
    const chainId = await publicClient.getChainId();
    assert.equal(chainId, BASE, "fork must be Base for the module to exist");
    const chain = defineChain({
      id: chainId,
      name: "safe-fork",
      nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
      rpcUrls: { default: { http: [rpc!] } },
    });
    const ownerWallet = createWalletClient({ account: owner, chain, transport: http(rpc!) });

    // A single-owner Safe stands in for a seat's treasury.
    const safeConfig = {
      provider: rpc!,
      signer: pk!,
      owners: [owner.address] as `0x${string}`[],
      threshold: 1,
      saltNonce: `lacrew-allowance-${delegate.address}`,
    };
    const predicted = await predictSafeWallet(safeConfig);
    if (!predicted.deployed) {
      const deployment = await deploySafeWallet(safeConfig);
      const hash = await ownerWallet.sendTransaction({
        to: deployment.to,
        data: deployment.data,
        value: deployment.value,
      });
      assert.equal(
        (await publicClient.waitForTransactionReceipt({ hash })).status,
        "success",
      );
    }
    const safeAddress = predicted.address;

    // Fund the Safe, and the delegate for gas.
    const budget = parseEther("1");
    for (const [to, value] of [
      [safeAddress, parseEther("2")],
      [delegate.address, parseEther("1")],
    ] as const) {
      const hash = await ownerWallet.sendTransaction({ to, value });
      await publicClient.waitForTransactionReceipt({ hash });
    }

    const exec = { provider: rpc!, signer: pk!, safeAddress };
    const moduleAddress = getAllowanceModuleAddress(chainId);

    // 1. Enable the module, idempotently.
    await enableSafeModule(exec, moduleAddress);
    assert.equal(await isModuleEnabled(exec, moduleAddress), true);
    assert.equal(
      await enableSafeModule(exec, moduleAddress),
      null,
      "enabling twice must no-op rather than revert",
    );

    // 2. Register the delegate and set its budget, atomically via MultiSend.
    await executeSafeTransactions(
      exec,
      buildAllowanceSetupTxs(chainId, { delegate: delegate.address, amount: budget }),
    );

    assert.ok(
      (await readDelegates(publicClient, chainId, safeAddress))
        .map((d) => d.toLowerCase())
        .includes(delegate.address.toLowerCase()),
      "delegate should be registered on the Safe",
    );

    const granted = await readAllowance(
      publicClient,
      chainId,
      safeAddress,
      delegate.address,
    );
    assert.equal(granted.amount, budget);
    assert.equal(granted.spent, 0n);
    assert.equal(granted.remaining, budget);

    // 3. The delegate spends within budget — no owner key involved.
    const delegateWallet = createWalletClient({
      account: delegate,
      chain,
      transport: http(rpc!),
    });
    const spend = parseEther("0.4");
    const transfer = buildAllowanceTransferTx(chainId, {
      safe: safeAddress,
      to: payee.address,
      amount: spend,
      delegate: delegate.address,
    });
    const spendHash = await delegateWallet.sendTransaction({
      to: transfer.to,
      data: transfer.data,
      value: transfer.value,
    });
    assert.equal(
      (await publicClient.waitForTransactionReceipt({ hash: spendHash })).status,
      "success",
    );
    assert.equal(
      await publicClient.getBalance({ address: payee.address }),
      spend,
      `payee should hold ${formatEther(spend)} ETH from the Safe`,
    );

    const afterSpend = await readAllowance(
      publicClient,
      chainId,
      safeAddress,
      delegate.address,
    );
    assert.equal(afterSpend.spent, spend);
    assert.equal(afterSpend.remaining, budget - spend);

    // 4. The cap is enforced onchain: overspending the remainder reverts.
    const overdraft = buildAllowanceTransferTx(chainId, {
      safe: safeAddress,
      to: payee.address,
      amount: budget, // more than what is left
      delegate: delegate.address,
    });
    await assert.rejects(
      () =>
        delegateWallet.sendTransaction({
          to: overdraft.to,
          data: overdraft.data,
          value: overdraft.value,
        }),
      "spending past the allowance must revert",
    );
    assert.equal(
      await publicClient.getBalance({ address: payee.address }),
      spend,
      "a reverted overdraft must not move funds",
    );

    // 5. Revoking the delegate closes the seat.
    await executeSafeTransactions(exec, [
      buildRemoveDelegateTx(chainId, delegate.address),
    ]);
    const revoked = await buildAllowanceTransferTx(chainId, {
      safe: safeAddress,
      to: payee.address,
      amount: parseEther("0.1"),
      delegate: delegate.address,
    });
    await assert.rejects(
      () =>
        delegateWallet.sendTransaction({
          to: revoked.to,
          data: revoked.data,
          value: revoked.value,
        }),
      "a revoked session key must not spend",
    );
  },
);

test(
  "a non-delegate cannot spend the Safe's budget",
  { skip: skipChain, timeout: 120_000 },
  async () => {
    const owner = privateKeyToAccount(pk as `0x${string}`);
    const intruder = privateKeyToAccount(generatePrivateKey());
    const publicClient = createPublicClient({ transport: http(rpc!) });
    const chainId = await publicClient.getChainId();
    const chain = defineChain({
      id: chainId,
      name: "safe-fork",
      nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
      rpcUrls: { default: { http: [rpc!] } },
    });
    const ownerWallet = createWalletClient({ account: owner, chain, transport: http(rpc!) });

    const safeConfig = {
      provider: rpc!,
      signer: pk!,
      owners: [owner.address] as `0x${string}`[],
      threshold: 1,
      saltNonce: "lacrew-allowance-intruder",
    };
    const predicted = await predictSafeWallet(safeConfig);
    if (!predicted.deployed) {
      const d = await deploySafeWallet(safeConfig);
      const h = await ownerWallet.sendTransaction({ to: d.to, data: d.data, value: d.value });
      await publicClient.waitForTransactionReceipt({ hash: h });
    }
    const fund = await ownerWallet.sendTransaction({
      to: predicted.address,
      value: parseEther("1"),
    });
    await publicClient.waitForTransactionReceipt({ hash: fund });
    const gas = await ownerWallet.sendTransaction({
      to: intruder.address,
      value: parseEther("1"),
    });
    await publicClient.waitForTransactionReceipt({ hash: gas });

    const exec = { provider: rpc!, signer: pk!, safeAddress: predicted.address };
    await enableSafeModule(exec, getAllowanceModuleAddress(chainId));

    // No allowance was ever granted to this address.
    const intruderWallet = createWalletClient({
      account: intruder,
      chain,
      transport: http(rpc!),
    });
    const tx = buildAllowanceTransferTx(chainId, {
      safe: predicted.address,
      to: intruder.address,
      amount: parseEther("0.5"),
      delegate: intruder.address,
    });
    await assert.rejects(
      () =>
        intruderWallet.sendTransaction({ to: tx.to, data: tx.data, value: tx.value }),
      "an unregistered delegate must not spend",
    );

    const state = await readAllowance(
      publicClient,
      chainId,
      predicted.address,
      intruder.address,
      NATIVE_TOKEN,
    );
    assert.equal(state.amount, 0n);
  },
);

test(
  "a seat spends a USDC budget and refills after the reset window",
  { skip: skipChain, timeout: 300_000 },
  async () => {
    const owner = privateKeyToAccount(pk as `0x${string}`);
    const delegate = privateKeyToAccount(generatePrivateKey());
    const payee = privateKeyToAccount(generatePrivateKey());

    const publicClient = createPublicClient({ transport: http(rpc!) });
    const chainId = await publicClient.getChainId();
    assert.equal(chainId, BASE, "fork must be Base for USDC and the module");
    const chain = defineChain({
      id: chainId,
      name: "safe-fork",
      nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
      rpcUrls: { default: { http: [rpc!] } },
    });
    const ownerWallet = createWalletClient({ account: owner, chain, transport: http(rpc!) });
    const testClient = createTestClient({ chain, mode: "anvil", transport: http(rpc!) })
      .extend(publicActions)
      .extend(walletActions);

    const safeConfig = {
      provider: rpc!,
      signer: pk!,
      owners: [owner.address] as `0x${string}`[],
      threshold: 1,
      saltNonce: `lacrew-usdc-${delegate.address}`,
    };
    const predicted = await predictSafeWallet(safeConfig);
    if (!predicted.deployed) {
      const d = await deploySafeWallet(safeConfig);
      const h = await ownerWallet.sendTransaction({ to: d.to, data: d.data, value: d.value });
      await publicClient.waitForTransactionReceipt({ hash: h });
    }
    const safeAddress = predicted.address;

    // Fund the Safe with USDC from a whale, and the delegate with gas.
    const funded = 100_000_000n; // 100 USDC
    await testClient.impersonateAccount({ address: USDC_WHALE });
    await testClient.setBalance({ address: USDC_WHALE, value: parseEther("1") });
    const fundHash = await testClient.writeContract({
      account: USDC_WHALE,
      address: USDC,
      abi: ERC20,
      functionName: "transfer",
      args: [safeAddress, funded],
      chain,
    });
    await publicClient.waitForTransactionReceipt({ hash: fundHash });
    await testClient.stopImpersonatingAccount({ address: USDC_WHALE });
    const gasHash = await ownerWallet.sendTransaction({
      to: delegate.address,
      value: parseEther("1"),
    });
    await publicClient.waitForTransactionReceipt({ hash: gasHash });

    const exec = { provider: rpc!, signer: pk!, safeAddress };
    await enableSafeModule(exec, getAllowanceModuleAddress(chainId));

    // A refilling budget: 10 USDC per minute, the shape a recurring agent
    // stipend takes.
    const perPeriod = 10_000_000n; // 10 USDC
    await executeSafeTransactions(
      exec,
      buildAllowanceSetupTxs(chainId, {
        delegate: delegate.address,
        token: USDC,
        amount: perPeriod,
        resetTimeMin: 1,
      }),
    );

    const granted = await readAllowance(
      publicClient,
      chainId,
      safeAddress,
      delegate.address,
      USDC,
    );
    assert.equal(granted.amount, perPeriod);
    assert.equal(granted.resetTimeMin, 1, "budget should refill every minute");

    const balanceOf = (address: `0x${string}`) =>
      publicClient.readContract({
        address: USDC,
        abi: ERC20,
        functionName: "balanceOf",
        args: [address],
      });

    const delegateWallet = createWalletClient({
      account: delegate,
      chain,
      transport: http(rpc!),
    });
    const spendUsdc = async (amount: bigint) => {
      const tx = buildAllowanceTransferTx(chainId, {
        safe: safeAddress,
        token: USDC,
        to: payee.address,
        amount,
        delegate: delegate.address,
      });
      const hash = await delegateWallet.sendTransaction({
        to: tx.to,
        data: tx.data,
        value: tx.value,
      });
      return publicClient.waitForTransactionReceipt({ hash });
    };

    // Spend the full period budget in two transfers.
    assert.equal((await spendUsdc(6_000_000n)).status, "success");
    assert.equal((await spendUsdc(4_000_000n)).status, "success");
    assert.equal(await balanceOf(payee.address), perPeriod);
    assert.equal(await balanceOf(safeAddress), funded - perPeriod);

    const exhausted = await readAllowance(
      publicClient,
      chainId,
      safeAddress,
      delegate.address,
      USDC,
    );
    assert.equal(exhausted.spent, perPeriod);
    assert.equal(exhausted.remaining, 0n, "period budget should be used up");

    // The cap holds even though the Safe still holds 90 USDC — this is the
    // point of the module: funds present but not spendable by this seat.
    await assert.rejects(
      () => spendUsdc(1n),
      "spending past the period cap must revert while the Safe is still funded",
    );
    assert.equal(await balanceOf(safeAddress), funded - perPeriod);

    // Cross the reset window: the budget refills without another owner action.
    await testClient.increaseTime({ seconds: 120 });
    await testClient.mine({ blocks: 1 });

    const refilled = await readAllowance(
      publicClient,
      chainId,
      safeAddress,
      delegate.address,
      USDC,
    );
    assert.equal(refilled.remaining, perPeriod, "budget should refill after the window");

    assert.equal((await spendUsdc(3_000_000n)).status, "success");
    assert.equal(await balanceOf(payee.address), perPeriod + 3_000_000n);
  },
);
