/**
 * Safe integration tests need a chain that already has the canonical Safe
 * singletons, so they skip unless SAFE_FORK_RPC is set. To run them:
 *
 *   anvil --port 8546 --fork-url https://mainnet.base.org
 *   SAFE_FORK_RPC=http://127.0.0.1:8546 \
 *   SAFE_FORK_PK=<an anvil dev key> pnpm --filter @lacrew/adapter-wallet-safe test
 *
 * The key is read from the environment so no key material lives in the repo.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { createPublicClient, createWalletClient, defineChain, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  connectSafeWallet,
  createMockSafeWallet,
  createMockSafeWalletAdapter,
  createSafeWalletAdapter,
  deploySafeWallet,
  mockSafeWalletAdapter,
  predictSafeWallet,
  toSaltNonce,
  type AdapterCheckInput,
} from "./index.js";

const SPEND: AdapterCheckInput = {
  agent: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  target: "0x4444444444444444444444444444444444444444",
  value: 200n * 10n ** 6n,
  data: "0x",
};

const OWNER_A = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266" as const;
const OWNER_B = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as const;

const rpc = process.env.SAFE_FORK_RPC;
const pk = process.env.SAFE_FORK_PK;
const skipChain = !rpc;

test("mock safe wallet reports its provider", async () => {
  const wallet = await createMockSafeWallet();
  assert.equal(wallet.provider, "safe");
  assert.equal(mockSafeWalletAdapter.provider, "safe");
});

test("bound mock adapter reads the verdict from the policy reader", async () => {
  const adapter = createMockSafeWalletAdapter({
    async checkPolicy() {
      return "ALLOW";
    },
  });

  // 200 USDC is over the mock cap, so ALLOW can only come from the reader.
  assert.equal(await adapter.checkPolicy(SPEND), "ALLOW");
  assert.equal(await mockSafeWalletAdapter.checkPolicy(SPEND), "ESCALATE");
});

test("real adapter without a reader refuses to guess a verdict", () => {
  const adapter = createSafeWalletAdapter({
    provider: "http://127.0.0.1:8545",
    owners: [OWNER_A],
  });
  assert.throws(() => adapter.checkPolicy(SPEND), /No PolicyReader bound/);
});

test("an unsatisfiable threshold is rejected before touching the chain", async () => {
  await assert.rejects(
    () =>
      predictSafeWallet({
        provider: "http://127.0.0.1:8545",
        owners: [OWNER_A],
        threshold: 2,
      }),
    /threshold 2 is out of range for 1 owner/,
  );
  await assert.rejects(
    () => predictSafeWallet({ provider: "http://127.0.0.1:8545", owners: [] }),
    /at least one owner/,
  );
});

test("readable seat labels normalize to a numeric salt", () => {
  // protocol-kit BigInt-parses the salt, so a raw label would throw inside it.
  assert.equal(toSaltNonce("42"), "42");
  assert.match(toSaltNonce("worker-1"), /^\d+$/);
  assert.equal(toSaltNonce("worker-1"), toSaltNonce("worker-1"));
  assert.notEqual(toSaltNonce("worker-1"), toSaltNonce("worker-2"));
});

test(
  "predicted address is deterministic in the salt",
  { skip: skipChain },
  async () => {
    const base = { provider: rpc!, owners: [OWNER_A, OWNER_B], threshold: 2 };
    const first = await predictSafeWallet({ ...base, saltNonce: "1" });
    const again = await predictSafeWallet({ ...base, saltNonce: "1" });
    const other = await predictSafeWallet({ ...base, saltNonce: "2" });

    assert.match(first.address, /^0x[0-9a-fA-F]{40}$/);
    assert.equal(first.address, again.address);
    assert.notEqual(first.address, other.address);
    assert.equal(first.deployed, false);
    assert.equal(first.threshold, 2);
  },
);

test(
  "connecting to an undeployed Safe fails loudly",
  { skip: skipChain },
  async () => {
    const predicted = await predictSafeWallet({
      provider: rpc!,
      owners: [OWNER_A, OWNER_B],
      threshold: 2,
      saltNonce: "connect-miss",
    });
    await assert.rejects(
      () => connectSafeWallet({ provider: rpc!, safeAddress: predicted.address }),
      /No Safe deployed at/,
    );
  },
);

test(
  "a deployed Safe reports its onchain owners and threshold",
  { skip: skipChain || !pk, timeout: 120_000 },
  async () => {
    const account = privateKeyToAccount(pk as `0x${string}`);
    const publicClient = createPublicClient({ transport: http(rpc!) });
    const chainId = await publicClient.getChainId();
    const chain = defineChain({
      id: chainId,
      name: "safe-fork",
      nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
      rpcUrls: { default: { http: [rpc!] } },
    });

    const owners = [account.address, OWNER_B] as `0x${string}`[];
    const config = {
      provider: rpc!,
      signer: pk!,
      owners,
      threshold: 2,
      // Salt keyed to the run so a re-run against a live fork starts clean.
      saltNonce: `lacrew-${chainId}-${owners.join("")}`,
    };

    // Deploy only if this salt is still free, so re-runs against a long-lived
    // fork exercise the connect path instead of failing on an existing proxy.
    const predicted = await predictSafeWallet(config);
    if (!predicted.deployed) {
      const deployment = await deploySafeWallet(config);
      assert.equal(deployment.safeAddress, predicted.address);
      const wallet = createWalletClient({ account, chain, transport: http(rpc!) });
      const hash = await wallet.sendTransaction({
        to: deployment.to,
        data: deployment.data,
        value: deployment.value,
      });
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      assert.equal(receipt.status, "success");
    }

    const connected = await connectSafeWallet({
      provider: rpc!,
      safeAddress: predicted.address,
    });
    assert.equal(connected.deployed, true);
    assert.equal(connected.threshold, 2);
    assert.deepEqual(
      connected.owners.map((o) => o.toLowerCase()),
      owners.map((o) => o.toLowerCase()),
    );

    // The adapter surface resolves to that same live Safe.
    const adapter = createSafeWalletAdapter({
      provider: rpc!,
      safeAddress: predicted.address,
      reader: {
        async checkPolicy() {
          return "ALLOW";
        },
      },
    });
    const viaAdapter = await adapter.createWallet();
    assert.equal(viaAdapter.address, predicted.address);
    assert.equal(await adapter.checkPolicy(SPEND), "ALLOW");
  },
);
