/**
 * Intent action simulation (PRD F1.16).
 * Mock: heuristic gas + USDC delta + warnings from verdict/whitelist.
 * Onchain: still heuristic until full call-trace simulation lands.
 */

import type { IntentSimulation, Verdict } from "@lacrew/core";

export type SimulateIntentInput = {
  agent: `0x${string}`;
  target: `0x${string}`;
  value: bigint;
  verdict: Verdict;
  /** Optional display label for the spend asset. */
  asset?: string;
};

function formatUsdc(value: bigint): string {
  const neg = value < 0n;
  const abs = neg ? -value : value;
  const whole = abs / 10n ** 6n;
  const frac = abs % 10n ** 6n;
  const fracStr = frac === 0n ? "00" : frac.toString().padStart(6, "0").replace(/0+$/, "").padEnd(2, "0");
  return `${neg ? "-" : ""}${whole}.${fracStr}`;
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
    warnings.push("Spend requires manager/root approval (cap or whitelist escalation).");
  }

  // Deterministic-ish gas from value so UI doesn't look frozen.
  const gas = 90_000 + Number((input.value / 10n ** 4n) % 80_000n);

  return {
    status,
    gasEstimate: gas.toLocaleString("en-US"),
    assetChanges: [{ asset, delta: `-${usdc}`, direction: "out" }],
    warnings,
  };
}
