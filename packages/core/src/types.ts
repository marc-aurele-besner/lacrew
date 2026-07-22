/** Shared domain types for LaCrew protocol clients. */

export type NodeKind = "human_root" | "manager_agent" | "worker_agent";

export type Verdict = "ALLOW" | "ESCALATE" | "DENY";

export type GovernanceTier = "low" | "high";

export type GovernanceProposalState = "active" | "executed" | "vetoed" | "defeated";

/** Onchain governance proposal as read from GovernanceModule. */
export interface GovernanceProposal {
  id: string;
  proposer: `0x${string}`;
  tier: GovernanceTier;
  target: `0x${string}`;
  actionHash: `0x${string}`;
  data: `0x${string}`;
  yesVotes: number;
  noVotes: number;
  /** Human-seat yes votes (high-tier quorum). */
  yesHumanVotes?: number;
  deadline: number;
  eta: number;
  state: GovernanceProposalState;
}

/** Seat classification in GovernanceModule. Agent yes-weight counts for low tier only. */
export type GovernanceSeatRole = "none" | "human" | "agent";

/**
 * A seat in the electorate as GovernanceModule holds it.
 *
 * `power` is the weight the contract applies when this address votes; zero
 * means it cannot vote at all (`vote()` reverts `NoVotingPower`). Only `human`
 * seats accrue to `yesHumanVotes`, which is the sole gate for high-tier
 * execution — an agent seat can help carry a low-tier proposal but can never
 * satisfy a high-tier one.
 */
export interface GovernanceSeat {
  voter: `0x${string}`;
  /** Weight as the contract stores it. String to avoid precision loss. */
  power: string;
  role: GovernanceSeatRole;
}

/** Quorum thresholds and the root that may change them. All weights, not counts. */
export interface GovernanceConfig {
  /** All-seat yes-weight required for low tier. */
  quorumYes: string;
  /** Human-seat yes-weight required for high tier. */
  quorumHumanYes: string;
  /**
   * The only address that may call `setVotingPower` / `setQuorum*`. Note this
   * is NOT itself routed through governance: the root can re-weight the
   * electorate unilaterally, including granting itself quorum-clearing weight.
   */
  humanRoot: `0x${string}`;
}

export interface OrgNode {
  account: `0x${string}`;
  kind: NodeKind;
  parent: `0x${string}` | null;
  active: boolean;
  /** Display label for UIs; not stored onchain. */
  label?: string;
}

export interface Allowance {
  node: `0x${string}`;
  /** Token address; Mocked zero address means synthetic units. */
  token: `0x${string}`;
  balance: bigint;
  epoch: number;
  /**
   * The ceiling SpendCapPolicy will enforce for this agent — its own cap, or
   * the module default it inherits. Both are equally binding.
   *
   * Null means the dimension is not enforced at all (no SpendCapPolicy in the
   * stack), not "no limit set for this agent".
   *
   * Previously the onchain read reported `cap: balance`, so every agent
   * appeared to be spending exactly to its limit no matter what the policy
   * actually allowed.
   */
  cap: bigint | null;
}

/** Human-readable preflight of the agent's intended action (PRD F1.16). */
export type IntentSimulation = {
  status: "ok" | "warning" | "revert";
  gasEstimate: string;
  assetChanges: Array<{ asset: string; delta: string; direction: "in" | "out" }>;
  warnings: string[];
};

export interface Intent {
  id: string;
  agent: `0x${string}`;
  target: `0x${string}`;
  value: bigint;
  data: `0x${string}`;
  awaitingApprover: `0x${string}` | null;
  resolved: boolean;
  approved: boolean | null;
  verdict: Verdict;
  /** Attached at propose time for approver UX (mock heuristic or viem sim). */
  simulation?: IntentSimulation;
  /**
   * Set when the event announcing this intent was seen but its onchain row
   * could not be read, so `target`, `value` and `data` are unknown.
   *
   * The intent is still listed: it exists, somebody is waiting on it, and
   * dropping it would hide a pending approval. But an approver decides on the
   * target and the amount, so those must never be filled in with zeros — that
   * renders as "0 USDC → 0x0000…0000", which is a spend request nobody made.
   */
  unreadable?: boolean;
}

/**
 * The scopes a session key can carry. Closed on purpose: SessionRegistry
 * rejects a mask with any bit it does not know, so a scope invented here
 * without a matching bit onchain would be refused at issue time rather than
 * silently granting nothing.
 */
export type SessionScope = "propose:intent" | "spend:whitelist";

/** Bit positions, mirroring `SessionRegistry.SCOPE_*`. */
export const SESSION_SCOPE_BIT: Record<SessionScope, number> = {
  "propose:intent": 1 << 0,
  "spend:whitelist": 1 << 1,
};

export const SESSION_SCOPES = Object.keys(SESSION_SCOPE_BIT) as SessionScope[];

export function isSessionScope(value: string): value is SessionScope {
  return value in SESSION_SCOPE_BIT;
}

/**
 * Encode scopes for `SessionRegistry.issue`. Throws on an unknown scope: a
 * silently dropped scope would issue a key with less authority than the caller
 * asked for, which fails later and far from the cause.
 */
export function sessionScopeMask(scopes: readonly string[]): bigint {
  let mask = 0n;
  for (const scope of scopes) {
    if (!isSessionScope(scope)) {
      throw new Error(
        `unknown session scope "${scope}" — known scopes: ${SESSION_SCOPES.join(", ")}`,
      );
    }
    mask |= BigInt(SESSION_SCOPE_BIT[scope]);
  }
  return mask;
}

/** Decode a mask back to scope names, for display and persistence. */
export function sessionScopesFromMask(mask: bigint): SessionScope[] {
  return SESSION_SCOPES.filter((scope) => (mask & BigInt(SESSION_SCOPE_BIT[scope])) !== 0n);
}

export interface SessionKey {
  agent: `0x${string}`;
  /** Session id (onchain uint as string, or mock UUID). */
  keyId: string;
  expiresAt: number;
  /** Enforced by EscalationRouter via the onchain scope mask. */
  scopes: SessionScope[];
  /** Ephemeral EOA address registered onchain (when issued via SessionRegistry). */
  keyAddress?: `0x${string}`;
  /** Onchain max propose value (decimal string); enforced by EscalationRouter. */
  maxValue?: string;
  /** Sole allowed target (`0x0…0` / omit = any policy-allowed target). */
  allowedTarget?: `0x${string}`;
  /** true when revoked onchain or locally. */
  revoked?: boolean;
}

export interface ChainAddresses {
  chainId: number;
  orgRegistry: `0x${string}`;
  treasury: `0x${string}`;
  escalationRouter: `0x${string}`;
  governanceModule: `0x${string}`;
  spendCapPolicy: `0x${string}`;
  /** Optional extras present after DeployMockOrg. */
  mockUSDC?: `0x${string}`;
  policyStack?: `0x${string}`;
  /** Manager-node stack (no rate limit); worker uses `policyStack`. */
  managerPolicyStack?: `0x${string}`;
  whitelistPolicy?: `0x${string}`;
  /** Daily UTC window policy in the default worker stack (full-day = always open). */
  timeWindowPolicy?: `0x${string}`;
  epochStreamer?: `0x${string}`;
  sessionRegistry?: `0x${string}`;
  /** USDC settlement for marketplace sales. Independent of Treasury by design. */
  marketplacePayments?: `0x${string}`;
  /** Org node accounts seeded by DeployMockOrg. */
  humanRoot?: `0x${string}`;
  manager?: `0x${string}`;
  worker?: `0x${string}`;
  x402Target?: `0x${string}`;
}
