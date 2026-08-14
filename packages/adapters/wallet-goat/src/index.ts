/**
 * GOAT wallet adapter (PRD F3.3) — the fourth wallet provider behind the shared
 * `WalletAdapter` contract, after Coinbase CDP, Safe and MetaMask.
 *
 * GOAT is a toolkit, not a custody service: it hands an agent a wallet client
 * and the tools that call it. So this adapter has two halves. The `WalletAdapter`
 * reports the seat and reads verdicts from the onchain policy stack, exactly as
 * the other three do; `gateGoatWallet` puts that stack in front of the sends
 * GOAT's own tools make. Neither invents a verdict — an adapter without a
 * `PolicyReader` refuses rather than guessing.
 */

import type {
  AdapterCheckInput,
  PolicyReader,
  WalletAdapter,
} from "@lacrew/adapter-wallet-agentkit";
import type { WalletClient } from "viem";

import { createGoatWallet, createGoatWalletClient, type GoatWalletClient } from "./wallet.js";

export * from "./wallet.js";
export * from "./policyGate.js";
export type { AdapterCheckInput, PolicyReader, WalletAdapter };

export type GoatWalletAdapterOptions = {
  /** The GOAT wallet client holding this seat's account. */
  wallet: GoatWalletClient;
  /** Live policy module; without one `checkPolicy` refuses rather than guessing. */
  reader?: PolicyReader;
};

/**
 * A `WalletAdapter` backed by a GOAT wallet client.
 *
 * Unlike Safe and MetaMask, the `label` passed to `createWallet()` does not
 * derive an address: a GOAT client *is* one account, with no counterfactual
 * factory behind it. One adapter therefore describes one seat — build a second
 * adapter over a second client rather than expecting a second label to mint one.
 */
export function createGoatWalletAdapter(opts: GoatWalletAdapterOptions): WalletAdapter {
  return {
    provider: "goat",
    async createWallet(label?: string) {
      void label;
      const wallet = await createGoatWallet({ wallet: opts.wallet });
      return { address: wallet.address, provider: wallet.provider };
    },
    checkPolicy: (input) => {
      if (!opts.reader) {
        throw new Error(
          "No PolicyReader bound — pass `reader` to createGoatWalletAdapter() so verdicts come from the onchain PolicyStack.",
        );
      }
      return opts.reader.checkPolicy(input);
    },
  };
}

export type ViemGoatWalletAdapterOptions = {
  /** Signer for the seat. Must carry an account — see `createGoatWalletClient`. */
  client: WalletClient;
  reader?: PolicyReader;
};

/** The same adapter, building GOAT's client from a viem `WalletClient` first. */
export async function createGoatWalletAdapterFromViem(
  opts: ViemGoatWalletAdapterOptions,
): Promise<WalletAdapter> {
  const wallet = await createGoatWalletClient(opts.client);
  return createGoatWalletAdapter({ wallet, ...(opts.reader ? { reader: opts.reader } : {}) });
}
