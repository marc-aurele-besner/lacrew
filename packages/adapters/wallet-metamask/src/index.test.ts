/**
 * Adapter-contract and offline tests. The chain lifecycle lives in
 * delegation.test.ts and needs MM_FORK_RPC.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { assertWalletAdapterContract } from "@lacrew/adapter-wallet-agentkit/contract";
import { createMetaMaskWalletAdapter, getEnvironment, SUPPORTED_CHAIN_IDS } from "./index.js";

const SPEND = {
  agent: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  target: "0x4444444444444444444444444444444444444444",
  value: 200n * 10n ** 6n,
  data: "0x",
} as const;

const owner = { address: "0x1111111111111111111111111111111111111111" } as const;
const stubClient = {
  getChainId: async () => 8453,
  getCode: async () => "0x" as const,
};

test("Base and Base Sepolia have a delegation environment", async () => {
  for (const chainId of SUPPORTED_CHAIN_IDS) {
    const env = await getEnvironment(chainId);
    assert.match(String(env.DelegationManager), /^0x[0-9a-fA-F]{40}$/);
  }
  // Pinned: a redemption sent to the wrong address would silently do nothing.
  assert.equal(
    (await getEnvironment(8453)).DelegationManager,
    "0xdb9B1e94B5b69Df7e401DDbedE43491141047dB3",
  );
});

test("an unsupported chain reports plainly instead of returning a bad address", async () => {
  await assert.rejects(() => getEnvironment(31337), /not deployed on chain 31337/);
});

test("satisfies the shared WalletAdapter contract", async () => {
  await assertWalletAdapterContract({
    provider: "metamask",
    withReader: (reader) => createMetaMaskWalletAdapter({ client: stubClient, owner, reader }),
    withoutReader: () => createMetaMaskWalletAdapter({ client: stubClient, owner }),
    // Provisioning needs the kit and a chain; delegation.test.ts covers it.
  });
});

test("adapter honours a bound policy reader", async () => {
  const seen: unknown[] = [];
  const adapter = createMetaMaskWalletAdapter({
    client: stubClient,
    owner,
    reader: {
      async checkPolicy(input) {
        seen.push(input);
        return "DENY";
      },
    },
  });
  assert.equal(await adapter.checkPolicy(SPEND), "DENY");
  assert.deepEqual(seen, [SPEND]);
});
