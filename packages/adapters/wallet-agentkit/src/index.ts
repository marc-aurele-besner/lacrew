/**
 * Coinbase CDP / AgentKit wallet adapter (PRD F1.8).
 * Mocked: stub wallet handle; no CDP SDK calls.
 * Conforms to WalletAdapter so GOAT / EIP-7702 / Safe can share the surface.
 */

import type { Verdict } from "@lacrew/core";

/** Shared adapter contract — feature code depends on this, not a vendor SDK. */
export interface WalletAdapter {
  readonly provider: string;
  createWallet(label?: string): Promise<{ address: `0x${string}`; provider: string }>;
  checkPolicy(input: AdapterCheckInput): Verdict | Promise<Verdict>;
}

export interface AgentKitWallet {
  address: `0x${string}`;
  provider: "agentkit";
}

export interface AdapterCheckInput {
  agent: `0x${string}`;
  target: `0x${string}`;
  value: bigint;
  data: `0x${string}`;
}

/** Mocked wallet factory. */
export async function createAgentKitWallet(label = "mock-agent"): Promise<AgentKitWallet> {
  // TODO: Call CDP/AgentKit SDK to provision a real smart account.
  void label;
  return {
    address: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    provider: "agentkit",
  };
}

/**
 * Preflight a spend through the LaCrew policy standard.
 * Mocked: always ALLOW under 100 USDC units; else ESCALATE.
 */
export function checkWithPolicy(input: AdapterCheckInput): Verdict {
  // TODO: Delegate to onchain IPolicyModule stack for the agent node.
  const cap = 100n * 10n ** 6n;
  return input.value <= cap ? "ALLOW" : "ESCALATE";
}

export const agentKitWalletAdapter: WalletAdapter = {
  provider: "agentkit",
  createWallet: createAgentKitWallet,
  checkPolicy: checkWithPolicy,
};
