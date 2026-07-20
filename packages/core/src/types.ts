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
  /** Soft cap used by client-side policy preflight. */
  cap: bigint;
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
}

export interface SessionKey {
  agent: `0x${string}`;
  /** Session id (onchain uint as string, or mock UUID). */
  keyId: string;
  expiresAt: number;
  scopes: string[];
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
