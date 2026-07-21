/**
 * End-to-end settlement against real USDC. Skips unless X402_FORK_RPC is set:
 *
 *   anvil --port 8546 --fork-url https://mainnet.base.org
 *   X402_FORK_RPC=http://127.0.0.1:8546 pnpm --filter @lacrew/x402 test
 *
 * No credentials and no facilitator are involved — settlement is a plain call
 * to USDC's transferWithAuthorization, which is the property being proven.
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
  publicActions,
  walletActions,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  USDC,
  buildAuthorization,
  buildSettlementTxFromPayload,
  createPaymentRequirements,
  decodePaymentHeader,
  encodePaymentHeader,
  isAuthorizationUsed,
  resolveDomain,
  signAuthorization,
  toWire,
  verifyAuthorization,
  X402_VERSION,
  type PaymentPayload,
} from "./index.js";

const rpc = process.env.X402_FORK_RPC;
const skip = !rpc;

/** Aave v3 Base aUSDC — a large, stable USDC holder used only as a faucet. */
const USDC_WHALE = "0x4e65fE4DbA92790696d040ac24Aa414708F5c0AB" as const;
const ERC20 = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function transfer(address,uint256) returns (bool)",
]);

const base = defineChain({
  id: 8453,
  name: "base-fork",
  nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [rpc ?? "http://127.0.0.1:8546"] } },
});

function clients() {
  const transport = http(rpc!);
  return {
    publicClient: createPublicClient({ chain: base, transport }),
    testClient: createTestClient({ chain: base, mode: "anvil", transport })
      .extend(publicActions)
      .extend(walletActions),
  };
}

/** Move USDC from the whale to `to`, funding its gas first. */
async function fundUsdc(to: `0x${string}`, amount: bigint): Promise<void> {
  const { publicClient, testClient } = clients();
  await testClient.impersonateAccount({ address: USDC_WHALE });
  await testClient.setBalance({ address: USDC_WHALE, value: 10n ** 18n });
  const hash = await testClient.writeContract({
    account: USDC_WHALE,
    address: USDC.base.address,
    abi: ERC20,
    functionName: "transfer",
    args: [to, amount],
    chain: base,
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  assert.equal(receipt.status, "success", "whale funding must land");
  await testClient.stopImpersonatingAccount({ address: USDC_WHALE });
}

/**
 * Fresh keys: anvil's defaults carry EIP-7702 delegations on real Base, which
 * routes USDC signature checks down the ERC-1271 path and breaks ECDSA.
 */
function freshAccount() {
  return privateKeyToAccount(generatePrivateKey());
}

test("the fork exposes real Base USDC metadata", { skip }, async () => {
  const { publicClient } = clients();
  assert.equal(await publicClient.getChainId(), 8453);
  const domain = await resolveDomain(publicClient, USDC.base.address, 8453);
  // The hardcoded hints must match the deployed contract, or every signature
  // this package produces would be invalid onchain.
  assert.equal(domain.name, USDC.base.name);
  assert.equal(domain.version, USDC.base.version);
});

test(
  "a payer with no ETH pays, and an unrelated relayer settles",
  { skip, timeout: 180_000 },
  async () => {
    const { publicClient, testClient } = clients();
    const payer = freshAccount();
    const relayer = freshAccount();
    const payee = freshAccount();

    const price = 1_000_000n; // 1 USDC
    await fundUsdc(payer.address, 10_000_000n);

    // Gas for the relayer only. The payer deliberately holds zero ETH.
    await testClient.setBalance({ address: relayer.address, value: 10n ** 18n });
    assert.equal(
      await publicClient.getBalance({ address: payer.address }),
      0n,
      "payer must not need gas",
    );

    // --- Resource server: answer 402 with what it wants paid.
    const requirements = createPaymentRequirements({
      network: "base",
      payTo: payee.address,
      maxAmountRequired: price,
      resource: "https://api.example.com/report",
      description: "One metered report",
    });

    // --- Agent: sign an authorization and hand back an X-PAYMENT header.
    const domain = await resolveDomain(publicClient, requirements.asset, 8453, {
      name: requirements.extra?.name,
      version: requirements.extra?.version,
    });
    const authorization = buildAuthorization({
      from: payer.address,
      to: payee.address,
      value: price,
    });
    const signature = await signAuthorization(payer, domain, authorization);
    const header = encodePaymentHeader({
      x402Version: X402_VERSION,
      scheme: "exact",
      network: "base",
      payload: { signature, authorization: toWire(authorization) },
    } satisfies PaymentPayload);

    // --- Resource server: verify before spending gas.
    const payload = decodePaymentHeader(header);
    const verdict = await verifyAuthorization({
      domain,
      authorization,
      signature: payload.payload.signature,
      requirements,
    });
    assert.deepEqual(verdict, { valid: true });
    assert.equal(
      await isAuthorizationUsed(
        publicClient,
        requirements.asset,
        payer.address,
        authorization.nonce,
      ),
      false,
    );

    // --- Relayer: settle. It has no relationship with the payer.
    const settlement = buildSettlementTxFromPayload(requirements.asset, payload);
    const relayerWallet = createWalletClient({
      account: relayer,
      chain: base,
      transport: http(rpc!),
    });
    const hash = await relayerWallet.sendTransaction({
      to: settlement.to,
      data: settlement.data,
      value: settlement.value,
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    assert.equal(receipt.status, "success", "settlement must succeed");

    const balanceOf = (address: `0x${string}`) =>
      publicClient.readContract({
        address: USDC.base.address,
        abi: ERC20,
        functionName: "balanceOf",
        args: [address],
      });
    assert.equal(await balanceOf(payee.address), price, "payee received the payment");
    assert.equal(await balanceOf(payer.address), 10_000_000n - price, "payer was debited");
    assert.equal(
      await publicClient.getBalance({ address: payer.address }),
      0n,
      "payer still holds no ETH — the relayer paid the gas",
    );

    // --- Replay must fail: the nonce is now spent.
    assert.equal(
      await isAuthorizationUsed(
        publicClient,
        requirements.asset,
        payer.address,
        authorization.nonce,
      ),
      true,
    );
    await assert.rejects(
      () =>
        relayerWallet.sendTransaction({
          to: settlement.to,
          data: settlement.data,
          value: settlement.value,
        }),
      "replaying a settled authorization must revert",
    );
    assert.equal(await balanceOf(payee.address), price, "replay must not double-pay");
  },
);

test(
  "a tampered authorization is refused onchain, not just by the verifier",
  { skip, timeout: 180_000 },
  async () => {
    const { publicClient, testClient } = clients();
    const payer = freshAccount();
    const relayer = freshAccount();
    const payee = freshAccount();

    await fundUsdc(payer.address, 5_000_000n);
    await testClient.setBalance({ address: relayer.address, value: 10n ** 18n });

    const domain = await resolveDomain(publicClient, USDC.base.address, 8453);
    const authorization = buildAuthorization({
      from: payer.address,
      to: payee.address,
      value: 1_000_000n,
    });
    const signature = await signAuthorization(payer, domain, authorization);

    // Raise the amount after signing — the classic malicious-relayer move.
    const tampered = buildSettlementTxFromPayload(USDC.base.address, {
      x402Version: X402_VERSION,
      scheme: "exact",
      network: "base",
      payload: {
        signature,
        authorization: toWire({ ...authorization, value: 4_000_000n }),
      },
    });
    const relayerWallet = createWalletClient({
      account: relayer,
      chain: base,
      transport: http(rpc!),
    });
    await assert.rejects(
      () =>
        relayerWallet.sendTransaction({
          to: tampered.to,
          data: tampered.data,
          value: tampered.value,
        }),
      "USDC must reject an amount the payer never signed",
    );
    assert.equal(
      await publicClient.readContract({
        address: USDC.base.address,
        abi: ERC20,
        functionName: "balanceOf",
        args: [payee.address],
      }),
      0n,
      "no funds may move on a tampered authorization",
    );
  },
);
