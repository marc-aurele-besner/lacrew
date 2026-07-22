/**
 * A Safe paying an x402 invoice. Needs a chain with the Safe singletons and
 * real USDC, so it skips unless SAFE_FORK_RPC is set:
 *
 *   anvil --port 8546 --fork-url https://mainnet.base.org
 *   SAFE_FORK_RPC=http://127.0.0.1:8546 \
 *   SAFE_FORK_PK=<an anvil dev key> pnpm --filter @lacrew/adapter-wallet-safe test
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
  hashTypedData,
  parseEther,
  publicActions,
  walletActions,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  USDC as X402_USDC,
  buildAuthorization,
  buildSettlementTxAuto,
  createPaymentRequirements,
  decodePaymentHeader,
  encodePaymentHeader,
  isAuthorizationUsed,
  resolvePayerType,
  resolveDomain,
  verifyAuthorization,
  verifyAuthorizationAuto,
  verifyContractAuthorization,
  X402_VERSION,
  type PaymentPayload,
} from "@lacrew/x402";
import { deploySafeWallet, predictSafeWallet, signSafeX402Authorization } from "./index.js";

const rpc = process.env.SAFE_FORK_RPC;
const pk = process.env.SAFE_FORK_PK;
const skip = !rpc || !pk;

const USDC = X402_USDC.base.address;
const USDC_WHALE = "0x4e65fE4DbA92790696d040ac24Aa414708F5c0AB" as const;
const ERC20 = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function transfer(address,uint256) returns (bool)",
]);

const chain = defineChain({
  id: 8453,
  name: "base-fork",
  nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [rpc ?? "http://127.0.0.1:8546"] } },
});

test("refuses to sign an authorization that pays from another account", async () => {
  await assert.rejects(
    () =>
      signSafeX402Authorization(
        {
          provider: rpc ?? "http://127.0.0.1:8546",
          signer: "0x" + "11".repeat(32),
          safeAddress: "0x1111111111111111111111111111111111111111",
        },
        {
          name: "USD Coin",
          version: "2",
          chainId: 8453,
          verifyingContract: USDC,
        },
        buildAuthorization({
          from: "0x2222222222222222222222222222222222222222",
          to: "0x3333333333333333333333333333333333333333",
          value: 1n,
        }),
      ),
    /but this Safe is/,
  );
});

test(
  "a Safe pays an x402 invoice via EIP-1271 and an unrelated relayer settles",
  { skip, timeout: 300_000 },
  async () => {
    const owner = privateKeyToAccount(pk as `0x${string}`);
    const relayer = privateKeyToAccount(generatePrivateKey());
    const payee = privateKeyToAccount(generatePrivateKey());

    const publicClient = createPublicClient({ chain, transport: http(rpc!) });
    assert.equal(await publicClient.getChainId(), 8453);
    const ownerWallet = createWalletClient({ account: owner, chain, transport: http(rpc!) });
    const testClient = createTestClient({ chain, mode: "anvil", transport: http(rpc!) })
      .extend(publicActions)
      .extend(walletActions);

    // A funded seat Safe.
    const safeConfig = {
      provider: rpc!,
      signer: pk!,
      owners: [owner.address] as `0x${string}`[],
      threshold: 1,
      saltNonce: `lacrew-x402-${payee.address}`,
    };
    const predicted = await predictSafeWallet(safeConfig);
    if (!predicted.deployed) {
      const d = await deploySafeWallet(safeConfig);
      const h = await ownerWallet.sendTransaction({ to: d.to, data: d.data, value: d.value });
      await publicClient.waitForTransactionReceipt({ hash: h });
    }
    const safeAddress = predicted.address;

    const funded = 10_000_000n; // 10 USDC
    await testClient.impersonateAccount({ address: USDC_WHALE });
    await testClient.setBalance({ address: USDC_WHALE, value: parseEther("1") });
    const fh = await testClient.writeContract({
      account: USDC_WHALE,
      address: USDC,
      abi: ERC20,
      functionName: "transfer",
      args: [safeAddress, funded],
      chain,
    });
    await publicClient.waitForTransactionReceipt({ hash: fh });
    await testClient.stopImpersonatingAccount({ address: USDC_WHALE });
    await testClient.setBalance({ address: relayer.address, value: parseEther("1") });

    // The Safe holds no ETH: it never sends a transaction here.
    assert.equal(await publicClient.getBalance({ address: safeAddress }), 0n);

    // --- Resource server asks for 1 USDC.
    const price = 1_000_000n;
    const requirements = createPaymentRequirements({
      network: "base",
      payTo: payee.address,
      maxAmountRequired: price,
      resource: "https://api.example.com/report",
    });
    const domain = await resolveDomain(publicClient, requirements.asset, 8453, {
      name: requirements.extra?.name,
      version: requirements.extra?.version,
    });

    // --- The Safe authorizes the transfer.
    const authorization = buildAuthorization({
      from: safeAddress,
      to: payee.address,
      value: price,
    });
    const signature = await signSafeX402Authorization(
      { provider: rpc!, signer: pk!, safeAddress },
      domain,
      authorization,
    );
    const payload = decodePaymentHeader(
      encodePaymentHeader({
        x402Version: X402_VERSION,
        scheme: "exact",
        network: "base",
        payload: {
          signature,
          authorization: {
            from: authorization.from,
            to: authorization.to,
            value: authorization.value.toString(),
            validAfter: authorization.validAfter.toString(),
            validBefore: authorization.validBefore.toString(),
            nonce: authorization.nonce,
          },
        },
      } satisfies PaymentPayload),
    );

    // --- The ecrecover check must reject a contract signature rather than
    // pretend it verified; the EIP-1271 check is the authority.
    const ecdsaVerdict = await verifyAuthorization({
      domain,
      authorization,
      signature,
      requirements,
    });
    assert.equal(ecdsaVerdict.valid, false, "a Safe signature must not verify as ECDSA");

    assert.deepEqual(
      await verifyContractAuthorization(publicClient, domain, authorization, signature),
      { valid: true },
    );
    assert.deepEqual(
      await verifyAuthorizationAuto({
        client: publicClient,
        domain,
        authorization,
        signature,
        requirements,
      }),
      { valid: true },
      "auto verification should detect the contract payer",
    );

    // --- Settlement picks the bytes overload from chain state, not signature
    // length: this Safe signature is also 65 bytes.
    assert.equal((signature.length - 2) / 2, 65, "guard: length cannot disambiguate");
    assert.equal(await resolvePayerType(publicClient, safeAddress), "contract");
    assert.equal(await resolvePayerType(publicClient, payee.address), "eoa");

    const settlement = await buildSettlementTxAuto(publicClient, requirements.asset, payload);
    const relayerWallet = createWalletClient({
      account: relayer,
      chain,
      transport: http(rpc!),
    });
    const hash = await relayerWallet.sendTransaction({
      to: settlement.to,
      data: settlement.data,
      value: settlement.value,
    });
    assert.equal(
      (await publicClient.waitForTransactionReceipt({ hash })).status,
      "success",
      "the Safe's EIP-1271 authorization must settle",
    );

    const balanceOf = (address: `0x${string}`) =>
      publicClient.readContract({
        address: USDC,
        abi: ERC20,
        functionName: "balanceOf",
        args: [address],
      });
    assert.equal(await balanceOf(payee.address), price);
    assert.equal(await balanceOf(safeAddress), funded - price);
    assert.equal(
      await publicClient.getBalance({ address: safeAddress }),
      0n,
      "the Safe paid without ever holding gas",
    );

    // --- Replay is burned by the nonce, exactly as for an EOA payer.
    assert.equal(
      await isAuthorizationUsed(publicClient, requirements.asset, safeAddress, authorization.nonce),
      true,
    );
    await assert.rejects(
      () =>
        relayerWallet.sendTransaction({
          to: settlement.to,
          data: settlement.data,
          value: settlement.value,
        }),
      "replaying the Safe's authorization must revert",
    );
    assert.equal(await balanceOf(payee.address), price, "replay must not double-pay");
  },
);

test(
  "a non-owner cannot authorize a payment from the Safe",
  { skip, timeout: 300_000 },
  async () => {
    const owner = privateKeyToAccount(pk as `0x${string}`);
    const outsiderKey = generatePrivateKey();
    const outsider = privateKeyToAccount(outsiderKey);
    const payee = privateKeyToAccount(generatePrivateKey());
    const publicClient = createPublicClient({ chain, transport: http(rpc!) });
    const ownerWallet = createWalletClient({ account: owner, chain, transport: http(rpc!) });

    const safeConfig = {
      provider: rpc!,
      signer: pk!,
      owners: [owner.address] as `0x${string}`[],
      threshold: 1,
      saltNonce: "lacrew-x402-outsider",
    };
    const predicted = await predictSafeWallet(safeConfig);
    if (!predicted.deployed) {
      const d = await deploySafeWallet(safeConfig);
      const h = await ownerWallet.sendTransaction({ to: d.to, data: d.data, value: d.value });
      await publicClient.waitForTransactionReceipt({ hash: h });
    }

    const domain = await resolveDomain(publicClient, USDC, 8453);
    const authorization = buildAuthorization({
      from: predicted.address,
      to: payee.address,
      value: 1_000_000n,
    });

    // protocol-kit refuses before producing anything, which is the better
    // failure: the caller learns immediately rather than at settlement.
    await assert.rejects(
      () =>
        signSafeX402Authorization(
          { provider: rpc!, signer: outsiderKey, safeAddress: predicted.address },
          domain,
          authorization,
        ),
      /only be signed by Safe owners/,
    );

    // And a forged signature — the outsider signing the digest directly, which
    // is what an attacker would actually submit — is refused by the Safe.
    const forged = await outsider.sign({
      hash: hashTypedData({
        domain,
        types: {
          TransferWithAuthorization: [
            { name: "from", type: "address" },
            { name: "to", type: "address" },
            { name: "value", type: "uint256" },
            { name: "validAfter", type: "uint256" },
            { name: "validBefore", type: "uint256" },
            { name: "nonce", type: "bytes32" },
          ],
        },
        primaryType: "TransferWithAuthorization",
        message: authorization,
      }),
    });
    const verdict = await verifyContractAuthorization(
      publicClient,
      domain,
      authorization,
      forged,
    );
    assert.equal(verdict.valid, false, "the Safe must reject a forged signature");
  },
);
