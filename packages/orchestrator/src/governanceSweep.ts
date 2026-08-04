/**
 * Governance auto-execute sweep (F0.6) — the decision half.
 *
 * Mirrors `GovernanceModule.execute()`'s acceptance rules so the sweep only
 * spends gas on proposals the chain would actually execute. The mirror is an
 * optimization, never the enforcer: a proposal it wrongly deems executable
 * still just reverts onchain, and one it wrongly skips stays available to a
 * human press.
 *
 * Two deliberate asymmetries with the contract:
 *  - `execute()` on a lapsed, losing proposal marks it Defeated and returns
 *    success. The sweep skips that case (`would_defeat`) — finalizing defeats
 *    costs gas for bookkeeping nobody asked this process to do.
 *  - Anything unreadable (missing human tally on a high-tier row) is skipped,
 *    not guessed.
 */

import type { GovernanceProposal } from "@lacrew/core";

/** The slice of GovernanceConfig the sweep decision needs. */
export interface SweepConfig {
  /** Seat-clamped quorums — what `execute()` actually gates on. */
  effectiveQuorumYes?: string;
  effectiveQuorumHumanYes?: string;
  totalHumanVotingPower?: string;
  unanimityFastPath?: boolean;
}

export type SweepDecision =
  | { execute: true; via: "timelock_elapsed" | "unanimity" | "quorum" }
  | {
      execute: false;
      reason:
        "not_active" | "quorum_not_met" | "timelock_pending" | "would_defeat" | "config_unreadable";
    };

export function decideAutoExecute(
  p: GovernanceProposal,
  config: SweepConfig,
  nowSeconds: number,
): SweepDecision {
  if (p.state !== "active") return { execute: false, reason: "not_active" };

  // A lapsed ballot the noes won: execute() would finalize it as Defeated.
  if (p.deadline > 0 && nowSeconds > p.deadline && p.noVotes > p.yesVotes) {
    return { execute: false, reason: "would_defeat" };
  }

  if (p.tier === "high") {
    if (config.effectiveQuorumHumanYes === undefined) {
      return { execute: false, reason: "config_unreadable" };
    }
    const humanYes = p.yesHumanVotes;
    if (humanYes === undefined) return { execute: false, reason: "config_unreadable" };
    if (BigInt(humanYes) < BigInt(config.effectiveQuorumHumanYes)) {
      return { execute: false, reason: "quorum_not_met" };
    }
    const totalHuman = BigInt(config.totalHumanVotingPower ?? "0");
    const unanimous =
      Boolean(config.unanimityFastPath) && totalHuman > 0n && BigInt(humanYes) >= totalHuman;
    if (nowSeconds < p.eta && !unanimous) {
      return { execute: false, reason: "timelock_pending" };
    }
    return {
      execute: true,
      via: unanimous && nowSeconds < p.eta ? "unanimity" : "timelock_elapsed",
    };
  }

  if (config.effectiveQuorumYes === undefined) {
    return { execute: false, reason: "config_unreadable" };
  }
  if (BigInt(p.yesVotes) < BigInt(config.effectiveQuorumYes)) {
    return { execute: false, reason: "quorum_not_met" };
  }
  return { execute: true, via: "quorum" };
}

/** Opt-in flag: executing governance without a human press is a policy decision. */
export function autoExecuteEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.LACREW_AUTO_EXECUTE === "1";
}
