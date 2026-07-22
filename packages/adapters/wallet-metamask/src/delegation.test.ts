/**
 * Full seat lifecycle against MetaMask smart accounts. Needs a chain with the
 * delegation framework deployed, so it skips unless MM_FORK_RPC is set:
 *
 *   anvil --port 8546 --fork-url https://mainnet.base.org
 *   MM_FORK_RPC=http://127.0.0.1:8546 pnpm --filter @lacrew/adapter-wallet-metamask test
 *
 * Fresh keys are generated per run rather than using anvil's defaults, which
 * carry EIP-7702 delegations on real Base and would change account behaviour.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createPublicClient,
  createTestClient,
  createWalletClient,
  defineChain,
  http,
  parseAbi,
  parseEther,
  publicActions,
  walletActions,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  buildAccountDeploymentTx,
  buildAgentDelegation,
  buildRedeemTx,
  createMetaMaskWallet,
  erc20TransferExecution,
  getMetaMaskSmartAccount,
  nativeTransferExecution,
  readRemainingBudget,
  signAgentDelegation,
  type Budget,
} from "./index.js";

const rpc = process.env.MM_FORK_RPC;
const skip = !rpc;
const BASE = 8453;

const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as const;
const USDC_WHALE = "0x4e65fE4DbA92790696d040ac24Aa414708F5c0AB" as const;
const ERC20 = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function transfer(address,uint256) returns (bool)",
]);

const chain = defineChain({
  id: BASE,
  name: "base-fork",
  nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [rpc ?? "http://127.0.0.1:8546"] } },
});

function clients() {
  const transport = http(rpc!);
  return {
    publicClient: createPublicClient({ chain, transport }),
    testClient: createTestClient({ chain, mode: "anvil", transport })
      .extend(publicActions)
      .extend(walletActions),
  };
}

/** Deploy a seat wallet and return everything needed to drive it. */
async function provisionSeat(salt: string) {
  const { publicClient, testClient } = clients();
  const owner = privateKeyToAccount(generatePrivateKey());
  await testClient.setBalance({ address: owner.address, value: parseEther("10") });

  const opts = { client: publicClient, owner, salt };
  const before = await createMetaMaskWallet(opts);
  assert.equal(before.provider, "metamask");
  assert.equal(before.deployed, false, "a fresh seat starts counterfactual");

  const deployTx = await buildAccountDeploymentTx(opts);
  assert.ok(deployTx, "an undeployed seat must yield a deployment transaction");
  const ownerWallet = createWalletClient({ account: owner, chain, transport: http(rpc!) });
  const hash = await ownerWallet.sendTransaction({
    to: deployTx.to,
    data: deployTx.data,
    value: deployTx.value,
  });
  assert.equal(
    (await publicClient.waitForTransactionReceipt({ hash })).status,
    "success",
  );

  const after = await createMetaMaskWallet(opts);
  assert.equal(after.deployed, true);
  assert.equal(after.address, before.address, "deploying must not move the address");
  assert.equal(
    await buildAccountDeploymentTx(opts),
    null,
    "re-provisioning a deployed seat must no-op rather than redeploy",
  );

  const account = await getMetaMaskSmartAccount(opts);
  return { owner, ownerWallet, account, address: after.address, publicClient, testClient };
}

async function fundUsdc(to: `0x${string}`, amount: bigint) {
  const { publicClient, testClient } = clients();
  await testClient.impersonateAccount({ address: USDC_WHALE });
  await testClient.setBalance({ address: USDC_WHALE, value: parseEther("1") });
  const hash = await testClient.writeContract({
    account: USDC_WHALE,
    address: USDC,
    abi: ERC20,
    functionName: "transfer",
    args: [to, amount],
    chain,
  });
  await publicClient.waitForTransactionReceipt({ hash });
  await testClient.stopImpersonatingAccount({ address: USDC_WHALE });
}

test("a delegation cannot be redeemed before it is signed", async () => {
  await assert.rejects(
    () =>
      buildRedeemTx(
        BASE,
        { delegate: "0x1", caveats: [] },
        nativeTransferExecution("0x1111111111111111111111111111111111111111", 1n),
      ),
    /unsigned/,
  );
});

test("an expiry already in the past is refused", async () => {
  await assert.rejects(
    () =>
      buildAgentDelegation({
        chainId: BASE,
        from: "0x1111111111111111111111111111111111111111",
        delegate: "0x2222222222222222222222222222222222222222",
        budget: { kind: "nativeTotal", maxAmount: 1n },
        expiresAt: 1,
      }),
    /already in the past/,
  );
});

test("remaining budget is only meaningful for period budgets", async () => {
  await assert.rejects(
    () =>
      readRemainingBudget({
        client: {},
        chainId: BASE,
        delegation: {},
        budget: { kind: "nativeTotal", maxAmount: 1n },
      }),
    /only applies to period budgets/,
  );
});

test(
  "a seat spends an ERC-20 budget from a session key and is stopped at the cap",
  { skip, timeout: 300_000 },
  async () => {
    const seat = await provisionSeat(`usdc-${Date.now()}`);
    const { publicClient, testClient } = seat;
    const delegate = privateKeyToAccount(generatePrivateKey());
    const payee = privateKeyToAccount(generatePrivateKey());
    await testClient.setBalance({ address: delegate.address, value: parseEther("1") });

    const funded = 10_000_000n; // 10 USDC
    const cap = 3_000_000n; // 3 USDC budget for this seat
    await fundUsdc(seat.address, funded);

    const budget: Budget = { kind: "erc20Total", token: USDC, maxAmount: cap };
    const delegation = await buildAgentDelegation({
      chainId: BASE,
      from: seat.address,
      delegate: delegate.address,
      budget,
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
    });
    const signed = await signAgentDelegation(seat.account, delegation);
    assert.ok(signed.signature, "delegation should carry a signature");

    const delegateWallet = createWalletClient({
      account: delegate,
      chain,
      transport: http(rpc!),
    });
    const spend = async (amount: bigint) => {
      const tx = await buildRedeemTx(
        BASE,
        signed,
        erc20TransferExecution(USDC, payee.address, amount),
      );
      const hash = await delegateWallet.sendTransaction({
        to: tx.to,
        data: tx.data,
        value: tx.value,
      });
      return publicClient.waitForTransactionReceipt({ hash });
    };
    const balanceOf = (address: `0x${string}`) =>
      publicClient.readContract({
        address: USDC,
        abi: ERC20,
        functionName: "balanceOf",
        args: [address],
      });

    // The session key spends without the owner key.
    assert.equal((await spend(2_000_000n)).status, "success");
    assert.equal(await balanceOf(payee.address), 2_000_000n);
    assert.equal(await balanceOf(seat.address), funded - 2_000_000n);

    // The cap holds even though the seat still holds 8 USDC — funds present,
    // not spendable by this key.
    await assert.rejects(
      () => spend(2_000_000n),
      "spending past the delegation cap must revert",
    );
    assert.equal(
      await balanceOf(payee.address),
      2_000_000n,
      "a reverted overspend must not move funds",
    );

    // The remainder within the cap is still usable.
    assert.equal((await spend(1_000_000n)).status, "success");
    assert.equal(await balanceOf(payee.address), cap);
  },
);

test(
  "an address with no delegation cannot spend the seat's funds",
  { skip, timeout: 300_000 },
  async () => {
    const seat = await provisionSeat(`intruder-${Date.now()}`);
    const { publicClient, testClient } = seat;
    const delegate = privateKeyToAccount(generatePrivateKey());
    const intruder = privateKeyToAccount(generatePrivateKey());
    const payee = privateKeyToAccount(generatePrivateKey());
    for (const a of [delegate.address, intruder.address]) {
      await testClient.setBalance({ address: a, value: parseEther("1") });
    }
    await fundUsdc(seat.address, 5_000_000n);

    const signed = await signAgentDelegation(
      seat.account,
      await buildAgentDelegation({
        chainId: BASE,
        from: seat.address,
        delegate: delegate.address,
        budget: { kind: "erc20Total", token: USDC, maxAmount: 1_000_000n },
      }),
    );

    // The delegation names `delegate`; the DelegationManager checks msg.sender,
    // so possessing the signed delegation is not enough to spend it.
    const tx = await buildRedeemTx(
      BASE,
      signed,
      erc20TransferExecution(USDC, payee.address, 1_000_000n),
    );
    const intruderWallet = createWalletClient({
      account: intruder,
      chain,
      transport: http(rpc!),
    });
    await assert.rejects(
      () =>
        intruderWallet.sendTransaction({ to: tx.to, data: tx.data, value: tx.value }),
      "only the named delegate may redeem",
    );
    assert.equal(
      await publicClient.readContract({
        address: USDC,
        abi: ERC20,
        functionName: "balanceOf",
        args: [payee.address],
      }),
      0n,
    );
  },
);

test(
  "a native period budget refills and reports what is left",
  { skip, timeout: 300_000 },
  async () => {
    const seat = await provisionSeat(`period-${Date.now()}`);
    const { publicClient, testClient } = seat;
    const delegate = privateKeyToAccount(generatePrivateKey());
    const payee = privateKeyToAccount(generatePrivateKey());
    await testClient.setBalance({ address: delegate.address, value: parseEther("1") });
    await testClient.setBalance({ address: seat.address, value: parseEther("5") });

    const perPeriod = parseEther("1");
    const budget: Budget = {
      kind: "nativePeriod",
      periodAmount: perPeriod,
      periodDurationSeconds: 60,
      startDate: Math.floor(Date.now() / 1000) - 1,
    };
    const signed = await signAgentDelegation(
      seat.account,
      await buildAgentDelegation({
        chainId: BASE,
        from: seat.address,
        delegate: delegate.address,
        budget,
      }),
    );

    const delegateWallet = createWalletClient({
      account: delegate,
      chain,
      transport: http(rpc!),
    });
    const spend = async (amount: bigint) => {
      const tx = await buildRedeemTx(
        BASE,
        signed,
        nativeTransferExecution(payee.address, amount),
      );
      const hash = await delegateWallet.sendTransaction({
        to: tx.to,
        data: tx.data,
        value: tx.value,
      });
      return publicClient.waitForTransactionReceipt({ hash });
    };

    assert.equal(
      await readRemainingBudget({
        client: publicClient,
        chainId: BASE,
        delegation: signed,
        budget,
      }),
      perPeriod,
      "a fresh period should report the full budget",
    );

    assert.equal((await spend(perPeriod)).status, "success");
    assert.equal(await publicClient.getBalance({ address: payee.address }), perPeriod);
    assert.equal(
      await readRemainingBudget({
        client: publicClient,
        chainId: BASE,
        delegation: signed,
        budget,
      }),
      0n,
      "the period budget should read as exhausted",
    );
    await assert.rejects(() => spend(1n), "the period cap must hold");

    // Crossing the period refills without any owner action.
    await testClient.increaseTime({ seconds: 120 });
    await testClient.mine({ blocks: 1 });
    assert.equal(
      await readRemainingBudget({
        client: publicClient,
        chainId: BASE,
        delegation: signed,
        budget,
      }),
      perPeriod,
      "the budget should refill after the period",
    );
    assert.equal((await spend(parseEther("0.5"))).status, "success");
  },
);
