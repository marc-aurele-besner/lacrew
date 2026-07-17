/**
 * Typed LaCrew client.
 * Mocked: reads/writes operate on in-memory demo org data.
 * TODO: Swap mock store for viem PublicClient / WalletClient against deployed contracts.
 */

import {
  mockAllowances,
  mockOrgNodes,
  mockPendingIntents,
  mockSessionKeys,
  type Allowance,
  type Intent,
  type OrgNode,
  type SessionKey,
  type Verdict,
} from "@lacrew/core";

export interface LacrewClientOptions {
  /** Reserved for future RPC / address config. */
  chainId?: number;
  /** When true (default), use Mocked demo data. */
  useMock?: boolean;
}

export class LacrewClient {
  private readonly useMock: boolean;
  private intents: Intent[];

  constructor(options: LacrewClientOptions = {}) {
    this.useMock = options.useMock ?? true;
    // Mocked: clone demo intents so approve mutations stay in-process.
    this.intents = mockPendingIntents.map((i) => ({ ...i }));
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

  /**
   * Propose an intent. Mocked: over-cap values escalate into local state.
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

    const allowances = await this.getAllowances(input.agent);
    const cap = allowances[0]?.cap ?? 0n;
    const verdict: Verdict = input.value <= cap ? "ALLOW" : "ESCALATE";

    if (verdict === "ALLOW") {
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
    return { intentId: intent.id, verdict };
  }

  /**
   * Approve or reject a pending intent.
   * TODO: Call EscalationRouter.resolve; recurse when parent policy requires it.
   */
  async resolveIntent(intentId: string, approved: boolean): Promise<Intent> {
    if (!this.useMock) {
      throw new Error("Onchain resolve is not implemented yet");
    }
    const intent = this.intents.find((i) => i.id === intentId);
    if (!intent) throw new Error(`Intent not found: ${intentId}`);
    intent.resolved = true;
    intent.approved = approved;
    return intent;
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
