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
}

export interface SessionKey {
  agent: `0x${string}`;
  /** Session id (onchain uint as string, or mock UUID). */
  keyId: string;
  expiresAt: number;
  scopes: string[];
  /** Ephemeral EOA address registered onchain (when issued via SessionRegistry). */
  keyAddress?: `0x${string}`;
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
  whitelistPolicy?: `0x${string}`;
  epochStreamer?: `0x${string}`;
  sessionRegistry?: `0x${string}`;
  /** Org node accounts seeded by DeployMockOrg. */
  humanRoot?: `0x${string}`;
  manager?: `0x${string}`;
  worker?: `0x${string}`;
  x402Target?: `0x${string}`;
}
