/**
 * Coinbase CDP / AgentKit wallet adapter (PRD F1.8).
 * Real provisioning lives in `./cdp.js`; this module owns the shared
 * `WalletAdapter` contract that Safe / GOAT / EIP-7702 adapters also implement.
 *
 * Every mocked value here is named `mock*` so a fake address can never be
 * reached by accident — real code paths go through `createCdpWalletAdapter`.
 */

import type { Verdict } from "@lacrew/core";

export * from "./cdp.js";

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

/** Mocked wallet factory — fixed address, no CDP call. Demos and tests only. */
export async function createMockAgentKitWallet(label = "mock-agent"): Promise<AgentKitWallet> {
  void label;
  return {
    address: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    provider: "agentkit",
  };
}

/**
 * Reader for an onchain IPolicyModule — satisfied by `OnchainLacrewClient`.
 * Adapters depend on this shape, never on a concrete client or vendor SDK.
 */
export interface PolicyReader {
  checkPolicy(input: AdapterCheckInput): Promise<Verdict>;
}

/**
 * Preflight a spend through the LaCrew policy standard.
 * Mocked: always ALLOW under 100 USDC units; else ESCALATE.
 * Used only when no `PolicyReader` is wired — see `checkWithPolicyReader`.
 */
export function checkWithPolicy(input: AdapterCheckInput): Verdict {
  const cap = 100n * 10n ** 6n;
  return input.value <= cap ? "ALLOW" : "ESCALATE";
}

/**
 * Preflight against the real onchain policy stack.
 * The verdict is advisory: enforcement stays onchain at propose time, so a
 * reader failure must not silently read as ALLOW — it surfaces to the caller.
 */
export async function checkWithPolicyReader(
  reader: PolicyReader,
  input: AdapterCheckInput,
): Promise<Verdict> {
  return reader.checkPolicy(input);
}

/** Bind an adapter to a live policy module; without a reader it stays mocked. */
export function withPolicyReader(adapter: WalletAdapter, reader: PolicyReader): WalletAdapter {
  return {
    provider: adapter.provider,
    createWallet: (label?: string) => adapter.createWallet(label),
    checkPolicy: (input) => checkWithPolicyReader(reader, input),
  };
}

/** Fully mocked adapter — mock address and mock verdicts. Never for funds. */
export const mockAgentKitWalletAdapter: WalletAdapter = {
  provider: "agentkit",
  createWallet: createMockAgentKitWallet,
  checkPolicy: checkWithPolicy,
};

/**
 * Mocked wallet addresses with real onchain verdicts — useful while an org's
 * policy stack is live but wallets are not yet provisioned.
 * For real wallets use `createCdpWalletAdapter({ reader, ... })`.
 */
export function createMockAgentKitWalletAdapter(reader: PolicyReader): WalletAdapter {
  return withPolicyReader(mockAgentKitWalletAdapter, reader);
}
