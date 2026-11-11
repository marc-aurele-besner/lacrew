/**
 * The protocol surface every ledger-backed client answers: the reads and writes
 * that mirror the contracts (org tree, treasury, sessions, escalation, policy,
 * epochs, governance).
 *
 * Type-only. A consumer written against `ProtocolClient` works over any ledger
 * that enforces the contract rules; `ledger` says which one produced an answer.
 * Whatever needs an actual chain — marketplace settlement, module deployment,
 * gas receipts, native balances — stays on the concrete client that has one.
 */

import type { Account, Hex } from "viem";
import type {
  Allowance,
  ChainAddresses,
  EpochGrant,
  GovernanceConfig,
  GovernanceProposal,
  GovernanceSeat,
  GovernanceTier,
  Intent,
  NodePolicyStack,
  OrgNode,
  ProtocolEvent,
  SessionKey,
  TreasuryBalance,
  Verdict,
} from "@lacrew/core";

type Address = `0x${string}`;

/** Where a client's answers come from: mined blocks, or the in-process simulator. */
export type ProtocolLedger = "chain" | "sandbox";

/**
 * What a write hands back to name itself. A chain write carries the hash of the
 * transaction that was mined; a simulated one carries a `simTxId` and never a
 * `txHash`, so nothing downstream can mistake it for something on a chain.
 */
export type WriteRef = {
  txHash?: Hex;
  simTxId?: string;
};

/** `SessionRegistry.keyLimits` plus the window and rate of the session behind the key. */
export type SessionKeyLimits = {
  valid: boolean;
  maxValue: bigint;
  allowedTarget: Address;
  window?: { start: number; end: number };
  rate?: { maxProposals: number; ratePeriod: number };
};

export type ProtocolResolveResult = WriteRef & {
  intent: Intent;
  /** true when the intent climbed to a higher approver instead of closing. */
  escalated: boolean;
};

export type IssueSessionInput = {
  agent: Address;
  key: Address;
  expiresAtSec: number;
  /** Scope bitmask; see `sessionScopeMask` in @lacrew/core. */
  scopeMask: bigint;
  /** Max propose value; defaults to max uint256 (unlimited). */
  maxValue?: bigint;
  /** Sole allowed target; defaults to zero (any policy-allowed target). */
  allowedTarget?: Address;
  /** Full pinned target set. Takes precedence over `allowedTarget`. */
  allowedTargets?: Address[];
  /** Daily allowed window in seconds since midnight UTC, `[start, end)`. */
  window?: { start: number; end: number };
  /** Propose rate limit: at most `maxProposals` per `ratePeriod` seconds. */
  rate?: { maxProposals: number; ratePeriod: number };
};

export interface ProtocolClient {
  readonly ledger: ProtocolLedger;
  /** The contracts this client reads and writes, by role. */
  readonly addresses: ChainAddresses;

  // ——— OrgRegistry ———
  getOrgTree(): Promise<OrgNode[]>;

  // ——— Treasury ———
  getAllowances(node?: Address, asset?: string): Promise<Allowance[]>;
  getTreasuryBalances(): Promise<TreasuryBalance[]>;

  // ——— EscalationRouter ———
  getPendingIntents(): Promise<Intent[]>;
  proposeIntent(input: {
    agent: Address;
    target: Address;
    value: bigint;
    data?: Hex;
    /** Session-key (or agent) account that sends `propose`. */
    account?: Account;
  }): Promise<WriteRef & { intentId: string; verdict: Verdict }>;
  resolveIntent(
    intentId: string,
    approved: boolean,
    approver?: Address,
  ): Promise<ProtocolResolveResult>;
  /** Dry-run `resolve(intentId, true)` as the seat the ledger is waiting on. */
  simulateResolveApproval(intentId: string): Promise<{ ok: boolean; reason?: string }>;
  readNodeRateRecorder(node: Address, asset?: string): Promise<Address>;

  // ——— Policy modules ———
  checkPolicy(input: {
    agent: Address;
    target: Address;
    value: bigint;
    data?: Hex;
    policyModule?: Address;
  }): Promise<Verdict>;
  getNodePolicies(opts?: { nodes?: Address[]; asset?: string }): Promise<NodePolicyStack[]>;
  /** `SpendCapPolicy.capOf`; undefined when no SpendCapPolicy exists. */
  capOf(agent: Address): Promise<bigint | undefined>;

  // ——— SessionRegistry ———
  getSessions(agent?: Address): Promise<SessionKey[]>;
  readKeyLimits(agent: Address, key: Address): Promise<SessionKeyLimits>;
  issueSession(input: IssueSessionInput): Promise<WriteRef & { sessionId: string }>;
  revokeSession(sessionId: string): Promise<WriteRef>;
  setIssuer(issuer: Address): Promise<WriteRef>;
  getIssuer(): Promise<Address>;

  // ——— EpochStreamer ———
  getCurrentEpoch(asset?: string): Promise<number>;
  getGrants(asset?: string): Promise<EpochGrant[]>;
  runEpoch(asset?: string): Promise<WriteRef & { epoch: number }>;

  // ——— GovernanceModule ———
  getProposals(): Promise<GovernanceProposal[]>;
  getProposal(proposalId: string): Promise<GovernanceProposal>;
  readGovernanceConfig(): Promise<GovernanceConfig>;
  readGovernanceSeat(voter: Address): Promise<GovernanceSeat>;
  readGovernanceSeats(opts?: { includeRevoked?: boolean }): Promise<GovernanceSeat[]>;
  readHasVoted(proposalId: string, voter: Address): Promise<boolean>;
  proposeGovernance(input: {
    tier: GovernanceTier;
    target: Address;
    data: Hex;
  }): Promise<WriteRef & { proposalId: string }>;
  voteGovernance(
    proposalId: string,
    support: boolean,
    opts?: { useResolver?: boolean },
  ): Promise<WriteRef>;
  vetoGovernance(proposalId: string): Promise<WriteRef>;
  executeGovernance(proposalId: string): Promise<WriteRef>;

  // ——— Governance actions, each one proposal bound to the calldata it will run ———
  proposeHire(input: {
    label: string;
    kind?: OrgNode["kind"];
    parent?: Address;
    account?: Address;
    tier?: GovernanceTier;
  }): Promise<WriteRef & { proposalId: string; account: Address }>;
  proposeFire(input: {
    account: Address;
    tier?: GovernanceTier;
  }): Promise<WriteRef & { proposalId: string; account: Address }>;
  proposeSetActive(input: {
    account: Address;
    active: boolean;
    tier?: GovernanceTier;
  }): Promise<WriteRef & { proposalId: string; account: Address }>;
  proposeReparent(input: {
    account: Address;
    newParent: Address;
    tier?: GovernanceTier;
  }): Promise<WriteRef & { proposalId: string; account: Address }>;
  proposeSetGrant(input: {
    account: Address;
    amount: bigint;
    tier?: GovernanceTier;
    asset?: string;
  }): Promise<WriteRef & { proposalId: string; account: Address }>;
  proposeSetGrants(input: {
    entries: Array<{ account: Address; amount: bigint }>;
    tier?: GovernanceTier;
    asset?: string;
  }): Promise<WriteRef & { proposalId: string; count: number }>;
  proposeSetNodePolicy(input: {
    node: Address;
    policyModule: Address;
    tier?: GovernanceTier;
    asset?: string;
  }): Promise<WriteRef & { proposalId: string; node: Address }>;
  proposeSetNodeRateRecorder(input: {
    node: Address;
    rateRecorder: Address;
    tier?: GovernanceTier;
    asset?: string;
  }): Promise<WriteRef & { proposalId: string; node: Address }>;
  proposeSetWhitelist(input: {
    target: Address;
    allowed: boolean;
    tier?: GovernanceTier;
    asset?: string;
  }): Promise<WriteRef & { proposalId: string; target: Address }>;
  proposeSetAgentCap(input: {
    agent: Address;
    cap: bigint;
    tier?: GovernanceTier;
    asset?: string;
  }): Promise<WriteRef & { proposalId: string; agent: Address }>;
  proposeAdmitHuman(input: {
    account: Address;
    power: bigint;
  }): Promise<WriteRef & { proposalId: string; account: Address }>;
  proposeRemoveHuman(input: {
    account: Address;
  }): Promise<WriteRef & { proposalId: string; account: Address }>;

  // ——— Audit ———
  getAuditTrail(): Promise<ProtocolEvent[]>;
}
