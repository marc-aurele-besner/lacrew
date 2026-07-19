/**
 * Intent action simulation (PRD F1.16).
 * Pure heuristic layer shared by mock + onchain paths: two-sided asset
 * diffs and policy-aware warnings when allowance/cap/whitelist context is
 * provided. Onchain approval outcomes ride simulateResolveApproval (viem
 * eth_call through the router's finalize path).
 */

import type { IntentSimulation, Verdict } from "@lacrew/core";

export type SimulateIntentInput = {
  agent: `0x${string}`;
  target: `0x${string}`;
  value: bigint;
  verdict: Verdict;
  /** Optional display label for the spend asset. */
  asset?: string;
  /** Agent's current allowance balance — flags would-revert overdrafts. */
  allowanceBalance?: bigint;
  /** Agent's per-intent policy cap — explains ESCALATE with numbers. */
  allowanceCap?: bigint;
  /** Whether the target passes the whitelist module. */
  whitelisted?: boolean;
};

function formatUsdc(value: bigint): string {
  const neg = value < 0n;
  const abs = neg ? -value : value;
  const whole = abs / 10n ** 6n;
  const frac = abs % 10n ** 6n;
  const fracStr = frac === 0n ? "00" : frac.toString().padStart(6, "0").replace(/0+$/, "").padEnd(2, "0");
  return `${neg ? "-" : ""}${whole}.${fracStr}`;
}

function shortAddr(addr: string): string {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

/** Build a human-readable simulation for an intended agent spend. */
export function simulateIntentAction(input: SimulateIntentInput): IntentSimulation {
  const asset = input.asset ?? "USDC";
  const usdc = formatUsdc(input.value);
  const warnings: string[] = [];
  let status: IntentSimulation["status"] = "ok";

  if (input.verdict === "DENY") {
    status = "revert";
    warnings.push("Policy DENY — call would revert under the current stack.");
  } else if (input.verdict === "ESCALATE") {
    status = "warning";
    if (input.allowanceCap !== undefined && input.value > input.allowanceCap) {
      warnings.push(
        `Spend ${usdc} ${asset} exceeds the agent's ${formatUsdc(input.allowanceCap)} ${asset} cap — needs manager/root approval.`,
      );
    } else if (input.whitelisted === false) {
      warnings.push(
        `Target ${shortAddr(input.target)} is not whitelisted — needs manager/root approval.`,
      );
    } else {
      warnings.push("Spend requires manager/root approval (cap or whitelist escalation).");
    }
  }

  if (
    input.allowanceBalance !== undefined &&
    input.value > input.allowanceBalance &&
    input.verdict !== "DENY"
  ) {
    status = "revert";
    warnings.push(
      `Allowance balance ${formatUsdc(input.allowanceBalance)} ${asset} cannot cover ${usdc} ${asset} — finalize would revert (run a payroll epoch first).`,
    );
  }

  // Deterministic-ish gas from value so UI doesn't look frozen.
  const gas = 90_000 + Number((input.value / 10n ** 4n) % 80_000n);

  return {
    status,
    gasEstimate: gas.toLocaleString("en-US"),
    assetChanges: [
      { asset: `${asset} (agent ${shortAddr(input.agent)})`, delta: `-${usdc}`, direction: "out" },
      { asset: `${asset} (target ${shortAddr(input.target)})`, delta: `+${usdc}`, direction: "in" },
    ],
    warnings,
  };
}
