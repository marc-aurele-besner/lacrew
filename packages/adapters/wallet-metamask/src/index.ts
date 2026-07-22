/**
 * MetaMask smart-account wallet adapter (PRD F1.8 / F3.3).
 *
 * The third wallet provider behind the shared `WalletAdapter` contract, after
 * Coinbase CDP and Safe. Delegations play the role the Safe AllowanceModule
 * plays there: a capped, expiring, revocable session key for an agent seat,
 * enforced onchain rather than by the orchestrator.
 *
 * As in the other adapters, nothing here holds key material or broadcasts, and
 * an adapter without a `PolicyReader` refuses to produce a verdict.
 */

import type { AdapterCheckInput, PolicyReader, WalletAdapter } from "@lacrew/adapter-wallet-agentkit";

import {
  createMetaMaskWallet,
  type CreateMetaMaskWalletOptions,
} from "./account.js";

export * from "./account.js";
export * from "./delegation.js";
export type { AdapterCheckInput, PolicyReader, WalletAdapter };

export type MetaMaskWalletAdapterOptions = Omit<CreateMetaMaskWalletOptions, "salt"> & {
  /** Fallback salt when `createWallet()` is called without a label. */
  salt?: string;
  /** Live policy module; without one `checkPolicy` refuses rather than guessing. */
  reader?: PolicyReader;
};

/**
 * A `WalletAdapter` backed by a MetaMask smart account. The `label` passed to
 * `createWallet()` becomes the account salt, so each seat maps to a stable
 * address.
 */
export function createMetaMaskWalletAdapter(
  opts: MetaMaskWalletAdapterOptions,
): WalletAdapter {
  return {
    provider: "metamask",
    async createWallet(label?: string) {
      const wallet = await createMetaMaskWallet({
        client: opts.client,
        owner: opts.owner,
        salt: label ?? opts.salt,
      });
      return { address: wallet.address, provider: wallet.provider };
    },
    checkPolicy: (input) => {
      if (!opts.reader) {
        throw new Error(
          "No PolicyReader bound — pass `reader` to createMetaMaskWalletAdapter() so verdicts come from the onchain PolicyStack.",
        );
      }
      return opts.reader.checkPolicy(input);
    },
  };
}
