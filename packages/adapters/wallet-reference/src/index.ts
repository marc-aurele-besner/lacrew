/**
 * Reference wallet (PRD F1.10) — proof that any WalletAdapter works.
 * In-memory EOA-ish handles + SDK policy check. Not a product wallet.
 */

import { MOCK_WORKER, type Verdict } from "@lacrew/core";
import {
  type AdapterCheckInput,
  type WalletAdapter,
  checkWithPolicy,
} from "@lacrew/adapter-wallet-agentkit";
import { createLacrewClient } from "@lacrew/sdk/testing";

export type { WalletAdapter, AdapterCheckInput };

export type ReferenceWallet = {
  address: `0x${string}`;
  provider: "reference";
  label: string;
};

const wallets = new Map<string, ReferenceWallet>();

function deriveAddress(label: string): `0x${string}` {
  // Deterministic fake address from label (demo only).
  let h = 0;
  for (let i = 0; i < label.length; i++) h = (h * 31 + label.charCodeAt(i)) >>> 0;
  const hex = h.toString(16).padStart(8, "0").repeat(5).slice(0, 40);
  return `0x${hex}` as `0x${string}`;
}

export async function createReferenceWallet(label = "ref-agent"): Promise<ReferenceWallet> {
  const existing = wallets.get(label);
  if (existing) return existing;
  const w: ReferenceWallet = {
    address: deriveAddress(label),
    provider: "reference",
    label,
  };
  wallets.set(label, w);
  return w;
}

export function checkReferencePolicy(input: AdapterCheckInput): Verdict {
  // Same PolicyModule-shaped preflight as AgentKit stub — swappable later.
  return checkWithPolicy(input);
}

export const referenceWalletAdapter: WalletAdapter = {
  provider: "reference",
  createWallet: createReferenceWallet,
  checkPolicy: checkReferencePolicy,
};

/**
 * Demo: create a wallet, propose via mock SDK if policy allows/escalates.
 * Returns the policy verdict + optional intent id.
 */
export async function referenceWalletDemoSpend(input: {
  label?: string;
  target: `0x${string}`;
  value: bigint;
}): Promise<{
  wallet: ReferenceWallet;
  verdict: Verdict;
  intentId?: string;
}> {
  const wallet = await createReferenceWallet(input.label ?? "ref-agent");
  const verdict = checkReferencePolicy({
    agent: wallet.address,
    target: input.target,
    value: input.value,
    data: "0x",
  });
  if (verdict === "DENY") {
    return { wallet, verdict };
  }
  const client = createLacrewClient({ useMock: true });
  // Mock client keys off known demo agents; propose via the demo worker seat.
  const result = await client.proposeIntent({
    agent: MOCK_WORKER,
    target: input.target,
    value: input.value,
  });
  return {
    wallet,
    verdict: result.verdict,
    intentId: result.intentId !== "0" ? result.intentId : undefined,
  };
}
