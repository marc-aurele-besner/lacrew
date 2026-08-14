/**
 * Adapter-contract and offline tests.
 *
 * GOAT ships no local chain or dev credential path, so the seat here is a local
 * fake standing in for `@goat-sdk/wallet-viem`'s client — the shape is pinned
 * structurally, and the shared contract suite holds the adapter to the same
 * promises as Safe, CDP and MetaMask.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { assertWalletAdapterContract } from "@lacrew/adapter-wallet-agentkit/contract";
import {
  createGoatWallet,
  createGoatWalletAdapter,
  createGoatWalletAdapterFromViem,
  createGoatWalletClient,
  type GoatWalletClient,
} from "./index.js";

const SEAT = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as const;

/** Stand-in for GOAT's EVM wallet client — the only surface this package uses. */
function fakeGoatWallet(overrides: Partial<GoatWalletClient> = {}): GoatWalletClient {
  return {
    getAddress: () => SEAT,
    getChain: () => ({ type: "evm", id: 8453 }),
    async sendTransaction() {
      return { hash: "0xdead" };
    },
    ...overrides,
  };
}

test("satisfies the shared WalletAdapter contract", async () => {
  await assertWalletAdapterContract({
    provider: "goat",
    withReader: (reader) => createGoatWalletAdapter({ wallet: fakeGoatWallet(), reader }),
    withoutReader: () => createGoatWalletAdapter({ wallet: fakeGoatWallet() }),
    // The client already holds the account, so no credential or chain is needed
    // to report the seat.
    createsWalletOffline: true,
  });
});

test("the seat is the client's account, and a label cannot mint a second one", async () => {
  const adapter = createGoatWalletAdapter({ wallet: fakeGoatWallet() });
  const first = await adapter.createWallet("worker-1");
  const second = await adapter.createWallet("worker-2");
  assert.equal(first.address, SEAT);
  assert.equal(second.address, first.address);
  assert.equal(first.provider, "goat");
});

test("an account-less client is refused instead of becoming an empty seat", async () => {
  // GOAT returns "" here rather than throwing, which is the whole hazard.
  await assert.rejects(
    () => createGoatWallet({ wallet: fakeGoatWallet({ getAddress: () => "" }) }),
    /credentials missing/,
  );
  await assert.rejects(
    () =>
      createGoatWallet({
        wallet: fakeGoatWallet({
          getAddress: () => "0x0000000000000000000000000000000000000000",
        }),
      }),
    /credentials missing/,
  );
});

test("a non-EVM GOAT chain is refused, not checked against EVM policy", async () => {
  await assert.rejects(
    () => createGoatWallet({ wallet: fakeGoatWallet({ getChain: () => ({ type: "solana" }) }) }),
    /only GOAT's EVM wallet clients/,
  );
});

test("the viem path refuses a client with no account before touching the SDK", async () => {
  const clientWithoutAccount = { account: undefined } as never;
  await assert.rejects(() => createGoatWalletClient(clientWithoutAccount), /credentials missing/);
  await assert.rejects(
    () => createGoatWalletAdapterFromViem({ client: clientWithoutAccount }),
    /credentials missing/,
  );
});

test("the real GOAT SDK builds a client from a viem wallet client", async () => {
  // Exercises `viem()` from @goat-sdk/wallet-viem, so the structural type this
  // package depends on is checked against the vendor's actual client rather
  // than against the fake above.
  const { createWalletClient, http } = await import("viem");
  const { privateKeyToAccount } = await import("viem/accounts");
  const { base } = await import("viem/chains");
  const account = privateKeyToAccount(`0x${"11".repeat(32)}`);
  const wallet = await createGoatWalletClient(
    createWalletClient({ account, chain: base, transport: http("http://127.0.0.1:8545") }),
  );

  assert.equal(wallet.getAddress().toLowerCase(), account.address.toLowerCase());
  assert.deepEqual(
    { type: wallet.getChain().type, id: wallet.getChain().id },
    { type: "evm", id: base.id },
  );

  const seat = await createGoatWallet({ wallet });
  assert.equal(seat.provider, "goat");
  assert.equal(seat.chainId, base.id);
});
