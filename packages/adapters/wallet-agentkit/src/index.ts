/**
 * Coinbase CDP / AgentKit wallet adapter.
 * Mocked: returns a stub wallet handle; no CDP SDK calls.
 * TODO: Wrap AgentKit account creation + session keys behind IPolicyModule checks.
 */

import type { Verdict } from "@lacrew/core";

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
