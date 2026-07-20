/**
 * Typed LaCrew client.
 * Mocked: reads/writes operate on in-memory demo org data.
 * TODO: Swap mock store for viem PublicClient / WalletClient against deployed contracts.
 */

import {
  mockAllowances,
  mockAuditTrail,
  mockOrgNodes,
  mockPendingIntents,
  mockSessionKeys,
  type Allowance,
  type GovernanceProposal,
  type GovernanceTier,
  type Intent,
  type OrgNode,
  type ProtocolEvent,
  type SessionKey,
  type Verdict,
} from "@lacrew/core";
import {
  checkClientPolicy,
  defaultMockPolicy,
  type ClientPolicyConfig,
} from "./policy.js";
import { simulateIntentAction } from "./simulate.js";

export interface LacrewClientOptions {
  /** Reserved for future RPC / address config. */
  chainId?: number;
  /** When true (default), use Mocked demo data. */
  useMock?: boolean;
  /** Override client-side policy preflight. */
  policy?: ClientPolicyConfig;
}

export type ResolveResult = {
  intent: Intent;
  /** true when the intent climbed to a higher approver instead of closing. */
  escalated: boolean;
  /** Present when the write hit chain (createOnchainClient). */
  txHash?: `0x${string}`;
};

/** Mock governance action recorded at propose time, applied on execute. */
type MockProposalAction =
  | { kind: "hire"; account: `0x${string}`; nodeKind: OrgNode["kind"]; parent: `0x${string}`; label: string }
  | { kind: "fire"; account: `0x${string}` }
  | { kind: "setActive"; account: `0x${string}`; active: boolean }
  | { kind: "reparent"; account: `0x${string}`; newParent: `0x${string}` }
  | { kind: "setGrant"; account: `0x${string}`; amount: bigint }
  | { kind: "raw" };

export class LacrewClient {
  private readonly useMock: boolean;
  private readonly policy: ClientPolicyConfig;
  private intents: Intent[];
  private audit: ProtocolEvent[];
  private nodes: OrgNode[];
  private allowances: Allowance[];
  private proposals: GovernanceProposal[] = [];
  private readonly proposalActions = new Map<string, MockProposalAction>();
  private epoch = 0;

  constructor(options: LacrewClientOptions = {}) {
    this.useMock = options.useMock ?? true;
    this.policy = options.policy ?? defaultMockPolicy;
    // Mocked: clone demo state so mutations stay in-process.
    this.intents = mockPendingIntents.map((i) => ({ ...i }));
    this.audit = mockAuditTrail.map((e) => ({ ...e, payload: { ...e.payload } }));
    this.nodes = mockOrgNodes.map((n) => ({ ...n }));
    this.allowances = mockAllowances.map((a) => ({ ...a }));
  }

  private requireMock(what: string): void {
    if (!this.useMock) {
      throw new Error(`Onchain ${what} requires createOnchainClient`);
    }
  }

  /** List org nodes. */
  async getOrgTree(): Promise<OrgNode[]> {
    if (!this.useMock) {
      // TODO: Read OrgRegistry.getNode / getChildren via viem.
      throw new Error("Onchain org reads are not implemented yet");
    }
    return this.nodes.map((n) => ({ ...n }));
  }

  /** Allowances for all nodes (or a single node). */
  async getAllowances(node?: `0x${string}`): Promise<Allowance[]> {
    if (!this.useMock) {
      // TODO: Read Treasury.allowanceBalance for each node.
      throw new Error("Onchain allowance reads are not implemented yet");
    }
    const rows = node
      ? this.allowances.filter((a) => a.node.toLowerCase() === node.toLowerCase())
      : this.allowances;
    return rows.map((a) => ({ ...a }));
  }

  /** Pending escalations awaiting approval. */
  async getPendingIntents(): Promise<Intent[]> {
    if (!this.useMock) {
      // TODO: Index EscalationRouter IntentCreated events (Ponder).
      throw new Error("Onchain intent reads are not implemented yet");
    }
    return this.intents.filter((i) => !i.resolved);
  }

  /** Mocked event-sourced audit trail. */
  async getAuditTrail(): Promise<ProtocolEvent[]> {
    if (!this.useMock) {
      // TODO: Query Ponder/Postgres event index.
      throw new Error("Onchain audit trail is not implemented yet");
    }
    return this.audit;
  }

  /**
   * Propose an intent. Mocked: whitelist + spend-cap stack via checkClientPolicy.
   * TODO: Call EscalationRouter.propose onchain.
   */
  async proposeIntent(input: {
    agent: `0x${string}`;
    target: `0x${string}`;
    value: bigint;
    data?: `0x${string}`;
    /** Ignored in mock mode (onchain client uses this as the session signer). */
    account?: unknown;
  }): Promise<{ intentId: string; verdict: Verdict; txHash?: `0x${string}` }> {
    if (!this.useMock) {
      throw new Error("Onchain propose is not implemented yet");
    }

    const verdict = checkClientPolicy(this.policy, input);
    if (verdict === "DENY") {
      throw new Error("Policy DENY: target not whitelisted or otherwise forbidden");
    }

    if (verdict === "ALLOW") {
      this.audit.push({
        type: "AllowanceSpent",
        at: new Date().toISOString(),
        payload: {
          agent: input.agent,
          target: input.target,
          value: input.value.toString(),
        },
      });
      return { intentId: "0", verdict };
    }

    const node = mockOrgNodes.find(
      (n) => n.account.toLowerCase() === input.agent.toLowerCase(),
    );
    const intent: Intent = {
      id: `intent-mock-${this.intents.length + 1}`,
      agent: input.agent,
      target: input.target,
      value: input.value,
      data: input.data ?? "0x",
      awaitingApprover: node?.parent ?? null,
      resolved: false,
      approved: null,
      verdict,
      simulation: simulateIntentAction({
        agent: input.agent,
        target: input.target,
        value: input.value,
        verdict,
        allowanceBalance: this.allowances.find(
          (a) => a.node.toLowerCase() === input.agent.toLowerCase(),
        )?.balance,
        allowanceCap: Object.entries(this.policy.caps).find(
          ([key]) => key.toLowerCase() === input.agent.toLowerCase(),
        )?.[1],
        whitelisted: this.policy.whitelist.some(
          (t) => t.toLowerCase() === input.target.toLowerCase(),
        ),
      }),
    };
    this.intents.push(intent);
    this.audit.push({
      type: "IntentCreated",
      at: new Date().toISOString(),
      payload: {
        intentId: intent.id,
        agent: intent.agent,
        awaitingApprover: intent.awaitingApprover,
        value: intent.value.toString(),
      },
    });
    return { intentId: intent.id, verdict };
  }

  /**
   * Approve or reject a pending intent.
   * Mirrors onchain EscalationRouter: re-check policy as the approver; climb on ESCALATE.
   * TODO: Call EscalationRouter.resolve onchain.
   */
  async resolveIntent(
    intentId: string,
    approved: boolean,
    approver?: `0x${string}`,
  ): Promise<ResolveResult> {
    if (!this.useMock) {
      throw new Error("Onchain resolve is not implemented yet");
    }
    const intent = this.intents.find((i) => i.id === intentId);
    if (!intent) throw new Error(`Intent not found: ${intentId}`);
    if (intent.resolved) throw new Error(`Intent already resolved: ${intentId}`);

    const actingApprover = (approver ?? intent.awaitingApprover) as `0x${string}` | null;
    if (!actingApprover) throw new Error(`No awaiting approver for ${intentId}`);

    if (!approved) {
      intent.resolved = true;
      intent.approved = false;
      this.audit.push({
        type: "IntentResolved",
        at: new Date().toISOString(),
        payload: { intentId, approved: false },
      });
      return { intent, escalated: false };
    }

    const verdict = checkClientPolicy(this.policy, {
      agent: actingApprover,
      target: intent.target,
      value: intent.value,
    });

    if (verdict === "DENY") {
      intent.resolved = true;
      intent.approved = false;
      this.audit.push({
        type: "IntentResolved",
        at: new Date().toISOString(),
        payload: { intentId, approved: false, reason: "approver_deny" },
      });
      return { intent, escalated: false };
    }

    if (verdict === "ALLOW") {
      intent.resolved = true;
      intent.approved = true;
      this.audit.push({
        type: "IntentResolved",
        at: new Date().toISOString(),
        payload: { intentId, approved: true },
      });
      return { intent, escalated: false };
    }

    // ESCALATE — climb to the approver's parent.
    const approverNode = mockOrgNodes.find(
      (n) => n.account.toLowerCase() === actingApprover.toLowerCase(),
    );
    if (!approverNode?.parent || approverNode.kind === "human_root") {
      intent.resolved = true;
      intent.approved = true;
      this.audit.push({
        type: "IntentResolved",
        at: new Date().toISOString(),
        payload: { intentId, approved: true, reason: "root_finalize" },
      });
      return { intent, escalated: false };
    }

    const previous = intent.awaitingApprover;
    intent.awaitingApprover = approverNode.parent;
    this.audit.push({
      type: "IntentEscalated",
      at: new Date().toISOString(),
      payload: {
        intentId,
        from: previous,
        to: approverNode.parent,
      },
    });
    return { intent, escalated: true };
  }

  /** Active session keys for agents. */
  async getSessions(): Promise<SessionKey[]> {
    if (!this.useMock) {
      // TODO: Query session-key module / orchestrator session store.
      throw new Error("Onchain session reads are not implemented yet");
    }
    return mockSessionKeys;
  }

  /**
   * Mocked governance: records a ProposalCreated audit event only.
   * Use createOnchainClient for real propose/vote/execute.
   */
  async proposeGovernance(input: {
    tier: GovernanceTier;
    target: `0x${string}`;
    data?: `0x${string}`;
  }): Promise<{ proposalId: string }> {
    if (!this.useMock) {
      throw new Error("Onchain governance requires createOnchainClient");
    }
    const proposalId = `proposal-mock-${this.audit.length + 1}`;
    this.audit.push({
      type: "ProposalCreated",
      at: new Date().toISOString(),
      payload: {
        proposalId,
        tier: input.tier,
        target: input.target,
        data: input.data ?? "0x",
      },
    });
    return { proposalId };
  }

  // ── Mock governance lifecycle (mirrors GovernanceModule semantics) ──────

  private createMockProposal(
    tier: GovernanceTier,
    target: `0x${string}`,
    action: MockProposalAction,
    auditPayload: Record<string, unknown>,
  ): GovernanceProposal {
    const root = this.nodes.find((n) => n.kind === "human_root");
    const proposal: GovernanceProposal = {
      id: `proposal-mock-${this.proposals.length + 1}`,
      proposer: root?.account ?? "0x0000000000000000000000000000000000000000",
      tier,
      target,
      actionHash: "0x0000000000000000000000000000000000000000000000000000000000000000",
      data: "0x",
      yesVotes: 0,
      noVotes: 0,
      yesHumanVotes: 0,
      deadline: Math.floor(Date.now() / 1000) + 3 * 24 * 3600,
      eta: 0,
      state: "active",
    };
    this.proposals.push(proposal);
    this.proposalActions.set(proposal.id, action);
    this.audit.push({
      type: "ProposalCreated",
      at: new Date().toISOString(),
      payload: { proposalId: proposal.id, tier, ...auditPayload },
    });
    return proposal;
  }

  async getProposals(): Promise<GovernanceProposal[]> {
    this.requireMock("governance reads");
    return this.proposals.map((p) => ({ ...p }));
  }

  async getProposal(id: string): Promise<GovernanceProposal> {
    this.requireMock("governance reads");
    const proposal = this.proposals.find((p) => p.id === id);
    if (!proposal) throw new Error(`Proposal not found: ${id}`);
    return { ...proposal };
  }

  async proposeHire(input: {
    label: string;
    kind?: OrgNode["kind"];
    parent?: `0x${string}`;
    account?: `0x${string}`;
    tier?: GovernanceTier;
  }): Promise<{ proposalId: string; account: `0x${string}` }> {
    this.requireMock("governance");
    const manager = this.nodes.find((n) => n.kind === "manager_agent");
    const parent = input.parent ?? manager?.account ?? this.nodes[0]!.account;
    // Deterministic pseudo-address from the label (mock accounts, not keys).
    const hex = Buffer.from(input.label, "utf8").toString("hex").padEnd(40, "0").slice(0, 40);
    const account = input.account ?? (`0x${hex}` as `0x${string}`);
    const proposal = this.createMockProposal(
      input.tier ?? "low",
      account,
      { kind: "hire", account, nodeKind: input.kind ?? "worker_agent", parent, label: input.label },
      { account, label: input.label, action: "hire" },
    );
    return { proposalId: proposal.id, account };
  }

  async proposeFire(input: {
    account: `0x${string}`;
    tier?: GovernanceTier;
  }): Promise<{ proposalId: string; account: `0x${string}` }> {
    this.requireMock("governance");
    const proposal = this.createMockProposal(
      input.tier ?? "low",
      input.account,
      { kind: "fire", account: input.account },
      { account: input.account, action: "fire" },
    );
    return { proposalId: proposal.id, account: input.account };
  }

  async proposeSetActive(input: {
    account: `0x${string}`;
    active: boolean;
    tier?: GovernanceTier;
  }): Promise<{ proposalId: string; account: `0x${string}` }> {
    this.requireMock("governance");
    const proposal = this.createMockProposal(
      input.tier ?? "low",
      input.account,
      { kind: "setActive", account: input.account, active: input.active },
      { account: input.account, action: input.active ? "activate" : "deactivate" },
    );
    return { proposalId: proposal.id, account: input.account };
  }

  async proposeReparent(input: {
    account: `0x${string}`;
    newParent: `0x${string}`;
    tier?: GovernanceTier;
  }): Promise<{ proposalId: string; account: `0x${string}` }> {
    this.requireMock("governance");
    const proposal = this.createMockProposal(
      input.tier ?? "low",
      input.account,
      { kind: "reparent", account: input.account, newParent: input.newParent },
      { account: input.account, newParent: input.newParent, action: "reparent" },
    );
    return { proposalId: proposal.id, account: input.account };
  }

  async proposeSetGrant(input: {
    account: `0x${string}`;
    amount: bigint;
    tier?: GovernanceTier;
  }): Promise<{ proposalId: string; account: `0x${string}` }> {
    this.requireMock("governance");
    const proposal = this.createMockProposal(
      input.tier ?? "high",
      input.account,
      { kind: "setGrant", account: input.account, amount: input.amount },
      { account: input.account, amount: input.amount.toString(), action: "setGrant" },
    );
    return { proposalId: proposal.id, account: input.account };
  }

  /**
   * Mock vote: a supporting call casts the demo quorum (root human seat +
   * manager agent seat), mirroring the runtime's dual-seat onchain behavior.
   */
  async voteGovernance(
    proposalId: string,
    support: boolean,
  ): Promise<{ proposal: GovernanceProposal }> {
    this.requireMock("governance");
    const proposal = this.proposals.find((p) => p.id === proposalId);
    if (!proposal) throw new Error(`Proposal not found: ${proposalId}`);
    if (proposal.state !== "active") throw new Error(`Proposal not active: ${proposalId}`);
    if (support) {
      proposal.yesVotes += 2;
      proposal.yesHumanVotes = (proposal.yesHumanVotes ?? 0) + 1;
    } else {
      proposal.noVotes += 1;
    }
    this.audit.push({
      type: "ProposalVoted",
      at: new Date().toISOString(),
      payload: {
        proposalId,
        support,
        yesVotes: proposal.yesVotes,
        noVotes: proposal.noVotes,
      },
    });
    return { proposal: { ...proposal } };
  }

  async vetoGovernance(proposalId: string): Promise<{ proposal: GovernanceProposal }> {
    this.requireMock("governance");
    const proposal = this.proposals.find((p) => p.id === proposalId);
    if (!proposal) throw new Error(`Proposal not found: ${proposalId}`);
    if (proposal.tier !== "high") throw new Error("Only high-tier proposals can be vetoed");
    if (proposal.state !== "active") throw new Error(`Proposal not active: ${proposalId}`);
    proposal.state = "vetoed";
    this.audit.push({
      type: "ProposalVetoed",
      at: new Date().toISOString(),
      payload: { proposalId },
    });
    return { proposal: { ...proposal } };
  }

  async executeGovernance(proposalId: string): Promise<{ proposal: GovernanceProposal }> {
    this.requireMock("governance");
    const proposal = this.proposals.find((p) => p.id === proposalId);
    if (!proposal) throw new Error(`Proposal not found: ${proposalId}`);
    if (proposal.state !== "active") throw new Error(`Proposal not active: ${proposalId}`);
    const quorum =
      proposal.yesVotes >= 2 &&
      (proposal.tier === "low" || (proposal.yesHumanVotes ?? 0) >= 1);
    if (!quorum) throw new Error(`Quorum not met for ${proposalId}`);

    const action = this.proposalActions.get(proposalId);
    if (action?.kind === "hire") {
      this.nodes.push({
        account: action.account,
        kind: action.nodeKind,
        parent: action.parent,
        active: true,
        label: action.label,
      });
    } else if (action?.kind === "fire") {
      const fired = this.nodes.find(
        (n) => n.account.toLowerCase() === action.account.toLowerCase(),
      );
      if (fired) {
        fired.active = false;
        // Children rewire to the fired node's parent (OrgRegistry.removeNode).
        for (const n of this.nodes) {
          if (n.parent?.toLowerCase() === fired.account.toLowerCase()) {
            n.parent = fired.parent;
          }
        }
      }
    } else if (action?.kind === "setActive") {
      // Reversible suspend: the node keeps its place and its children.
      const node = this.nodes.find(
        (n) => n.account.toLowerCase() === action.account.toLowerCase(),
      );
      if (node) node.active = action.active;
    } else if (action?.kind === "reparent") {
      const node = this.nodes.find(
        (n) => n.account.toLowerCase() === action.account.toLowerCase(),
      );
      if (node) node.parent = action.newParent;
    } else if (action?.kind === "setGrant") {
      const allowance = this.allowances.find(
        (a) => a.node.toLowerCase() === action.account.toLowerCase(),
      );
      if (allowance) allowance.cap = action.amount;
    }

    proposal.state = "executed";
    this.audit.push({
      type: "ProposalExecuted",
      at: new Date().toISOString(),
      payload: { proposalId, state: "executed" },
    });
    return { proposal: { ...proposal } };
  }

  // ── Mock payroll epochs (mirrors EpochStreamer semantics) ───────────────

  async getCurrentEpoch(): Promise<number> {
    this.requireMock("epoch reads");
    return this.epoch;
  }

  /** Stream one epoch: every active allowance gains its per-epoch cap. */
  async runEpoch(): Promise<{ epoch: number }> {
    this.requireMock("epoch runs");
    this.epoch += 1;
    for (const allowance of this.allowances) {
      allowance.balance += allowance.cap;
      allowance.epoch = this.epoch;
    }
    this.audit.push({
      type: "AllowanceStreamed",
      at: new Date().toISOString(),
      payload: { epoch: this.epoch, via: "mock EpochStreamer" },
    });
    return { epoch: this.epoch };
  }
}

export function createLacrewClient(options?: LacrewClientOptions): LacrewClient {
  return new LacrewClient(options);
}

export {
  createOnchainClient,
  type OnchainClientOptions,
  type OnchainLacrewClient,
  type OnchainResolveResult,
} from "./onchain.js";
