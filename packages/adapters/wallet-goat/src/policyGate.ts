/**
 * The policy gate — where LaCrew composes with GOAT instead of competing.
 *
 * GOAT's tools spend by calling `sendTransaction` on the wallet client they
 * were handed, so gating that one method puts the org's onchain policy stack in
 * front of every GOAT tool, shipped and unshipped, without this package knowing
 * what any of them do.
 *
 * The verdict is advisory — enforcement stays onchain at propose time — but the
 * gate is not a hint: DENY and ESCALATE stop the send here rather than letting
 * a tool broadcast and learn the answer from a revert. There is no cap
 * heuristic to fall back on; without a reader the gate cannot be built.
 */

import type { Verdict } from "@lacrew/core";
import type { AdapterCheckInput, PolicyReader } from "@lacrew/adapter-wallet-agentkit";
import { encodeFunctionData, type Abi } from "viem";
import type { GoatTransaction, GoatWalletClient } from "./wallet.js";

/** A send the policy stack did not allow. Carries what was asked and answered. */
export class GoatPolicyError extends Error {
  readonly verdict: Verdict;
  readonly spend: AdapterCheckInput;

  constructor(verdict: Verdict, spend: AdapterCheckInput) {
    super(
      verdict === "DENY"
        ? `Policy denied this spend: ${spend.value} to ${spend.target}.`
        : `Policy escalated this spend: ${spend.value} to ${spend.target}. ` +
            "It needs a parent approval before it can be sent.",
    );
    this.name = "GoatPolicyError";
    this.verdict = verdict;
    this.spend = spend;
  }
}

export type GoatBlockedSpend = {
  verdict: Verdict;
  spend: AdapterCheckInput;
  transaction: GoatTransaction;
};

export type GoatPolicyGateOptions = {
  wallet: GoatWalletClient;
  /** Live policy module. Required — the gate has no heuristic to fall back to. */
  reader: PolicyReader;
  /** Seat the spend is checked as. Defaults to the wallet's own address. */
  agent?: `0x${string}`;
  /** Notified when a verdict stops a send — e.g. to open an escalation. */
  onBlocked?: (event: GoatBlockedSpend) => void | Promise<void>;
};

/**
 * Call data for a GOAT transaction.
 *
 * GOAT tools mostly describe a call as `abi` + `functionName` + `args` and let
 * the client encode it. Checking such a call against `0x` would ask the policy
 * stack about a plain transfer, so a whitelist or selector module would judge
 * something the agent is not about to do — hence the encode, and the refusal
 * when the ABI needed for it is absent.
 */
export function goatCallData(transaction: GoatTransaction): `0x${string}` {
  if (transaction.data) return transaction.data;
  if (!transaction.functionName) return "0x";
  if (!transaction.abi) {
    throw new Error(
      `GOAT transaction calls "${transaction.functionName}" but carries no ABI, so its call ` +
        "data cannot be built. Checking policy against `0x` would ask about a plain transfer.",
    );
  }
  return encodeFunctionData({
    abi: transaction.abi as Abi,
    functionName: transaction.functionName,
    args: (transaction.args ?? []) as never,
  });
}

/** The policy question a GOAT transaction asks, in adapter terms. */
export function toAdapterCheckInput(
  transaction: GoatTransaction,
  agent: `0x${string}`,
): AdapterCheckInput {
  if (!/^0x[0-9a-fA-F]{40}$/.test(transaction.to)) {
    throw new Error(
      `GOAT transaction targets "${transaction.to}", which is not an address. ` +
        "Resolve names before the gate, so policy is checked against what is actually called.",
    );
  }
  return {
    agent,
    target: transaction.to as `0x${string}`,
    value: transaction.value ?? 0n,
    data: goatCallData(transaction),
  };
}

/**
 * A GOAT wallet client whose sends are preflighted against the policy stack.
 *
 * Drop-in for the client GOAT tools already hold: same shape, same reads, and
 * an ALLOW sends exactly what was asked. Anything else throws `GoatPolicyError`
 * with the verdict, and a reader that cannot answer surfaces its own failure —
 * an unreachable RPC must never read as permission.
 */
export function gateGoatWallet(opts: GoatPolicyGateOptions): GoatWalletClient {
  const { wallet, reader } = opts;
  return {
    getAddress: () => wallet.getAddress(),
    getChain: () => wallet.getChain(),
    async sendTransaction(transaction) {
      const agent = opts.agent ?? (wallet.getAddress() as `0x${string}`);
      const spend = toAdapterCheckInput(transaction, agent);
      const verdict = await reader.checkPolicy(spend);
      if (verdict !== "ALLOW") {
        await opts.onBlocked?.({ verdict, spend, transaction });
        throw new GoatPolicyError(verdict, spend);
      }
      return wallet.sendTransaction(transaction);
    },
  };
}
