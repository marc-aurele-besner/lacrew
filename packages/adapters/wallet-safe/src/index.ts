/**
 * Safe smart-account wallet adapter (PRD F1.8).
 * Mocked: stub Safe address only. Implements WalletAdapter for swappability.
 */

import type { Verdict } from "@lacrew/core";

/** Keep aligned with @lacrew/adapter-wallet-agentkit WalletAdapter. */
export interface WalletAdapter {
  readonly provider: string;
  createWallet(label?: string): Promise<{ address: `0x${string}`; provider: string }>;
  checkPolicy(input: AdapterCheckInput): Verdict | Promise<Verdict>;
}

export interface AdapterCheckInput {
  agent: `0x${string}`;
  target: `0x${string}`;
  value: bigint;
  data: `0x${string}`;
}

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

/** Mocked policy preflight — same cap heuristic as AgentKit until onchain bind. */
export function checkWithPolicy(input: AdapterCheckInput): Verdict {
  const cap = 100n * 10n ** 6n;
  return input.value <= cap ? "ALLOW" : "ESCALATE";
}

export const safeWalletAdapter: WalletAdapter = {
  provider: "safe",
  async createWallet() {
    const w = await createSafeWallet();
    return { address: w.address, provider: w.provider };
  },
  checkPolicy: checkWithPolicy,
};
