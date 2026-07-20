/**
 * Safe smart-account wallet adapter (PRD F1.8).
 * Mocked: stub Safe address only. Implements WalletAdapter for swappability.
 * Policy verdicts are real once bound via `createSafeWalletAdapter`.
 */

import {
  checkWithPolicy,
  withPolicyReader,
  type AdapterCheckInput,
  type PolicyReader,
  type WalletAdapter,
} from "@lacrew/adapter-wallet-agentkit";

export { checkWithPolicy };
export type { AdapterCheckInput, PolicyReader, WalletAdapter };

export interface SafeWallet {
  address: `0x${string}`;
  provider: "safe";
  /** Mocked threshold; unused until real Safe wiring. */
  threshold: number;
}

export async function createSafeWallet(owners: `0x${string}`[] = []): Promise<SafeWallet> {
  // TODO: Deploy or connect a Safe with session-key / allowance modules.
  void owners;
  return {
    address: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    provider: "safe",
    threshold: 1,
  };
}

export const safeWalletAdapter: WalletAdapter = {
  provider: "safe",
  async createWallet() {
    const w = await createSafeWallet();
    return { address: w.address, provider: w.provider };
  },
  checkPolicy: checkWithPolicy,
};

/** Safe adapter reading verdicts from a live policy module instead of the mock. */
export function createSafeWalletAdapter(reader: PolicyReader): WalletAdapter {
  return withPolicyReader(safeWalletAdapter, reader);
}
