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
};

export class LacrewClient {
  private readonly useMock: boolean;
  private readonly policy: ClientPolicyConfig;
  private intents: Intent[];
  private audit: ProtocolEvent[];

  constructor(options: LacrewClientOptions = {}) {
    this.useMock = options.useMock ?? true;
    this.policy = options.policy ?? defaultMockPolicy;
    // Mocked: clone demo intents so approve mutations stay in-process.
    this.intents = mockPendingIntents.map((i) => ({ ...i }));
    this.audit = mockAuditTrail.map((e) => ({ ...e, payload: { ...e.payload } }));
  }

  /** List org nodes. */
  async getOrgTree(): Promise<OrgNode[]> {
    if (!this.useMock) {
      // TODO: Read OrgRegistry.getNode / getChildren via viem.
      throw new Error("Onchain org reads are not implemented yet");
    }
    return mockOrgNodes;
  }

  /** Allowances for all nodes (or a single node). */
  async getAllowances(node?: `0x${string}`): Promise<Allowance[]> {
    if (!this.useMock) {
      // TODO: Read Treasury.allowanceBalance for each node.
      throw new Error("Onchain allowance reads are not implemented yet");
    }
    if (!node) return mockAllowances;
    return mockAllowances.filter((a) => a.node.toLowerCase() === node.toLowerCase());
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
  }): Promise<{ intentId: string; verdict: Verdict }> {
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
