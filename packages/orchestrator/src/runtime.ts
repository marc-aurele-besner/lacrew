/**
 * Agent runtime: schedule work, propose intents, listen for events.
 * Defaults to mock SDK; when ANVIL_RPC + PRIVATE_KEY are set, uses createOnchainClient.
 * Onchain mode keeps a local audit ring from propose/resolve receipts so /audit
 * works without a separate indexer process.
 * TODO: OpenRouter model calls, MCP tool protocol.
 * Queue: QueueProvider (pg-boss when DATABASE_URL set; BullMQ later).
 */

import {
  createLacrewClient,
  createOnchainClient,
  type LacrewClient,
  type OnchainLacrewClient,
  type ResolveResult,
} from "@lacrew/sdk";
import {
  ANVIL_CHAIN_ID,
  escalationRouterAbi,
  getAddresses,
  MOCK_MANAGER,
  MOCK_WORKER,
  type GovernanceProposal,
  type GovernanceTier,
  type Intent,
  type ProtocolEvent,
  type SessionKey,
} from "@lacrew/core";
import { http, parseEther, parseEventLogs, type Hex, type Log } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { issueSession, isSessionExpired, revokeSession, createEphemeralSession } from "./sessions.js";

/** Anvil/demo gas stipend so the ephemeral session key can submit propose. */
const SESSION_GAS_STIPEND = parseEther("0.05");
/** Default session maxValue: 200 USDC (matches DeployMockOrg worker stream; over policy cap → escalate). */
const DEFAULT_SESSION_MAX_VALUE = 200n * 10n ** 6n;

export type RuntimeMode = "mock" | "onchain";

const AUDIT_RING_MAX = 200;

export interface CrewRuntimeOptions {
  client?: LacrewClient | OnchainLacrewClient;
  workerAgent?: `0x${string}`;
  spendTarget?: `0x${string}`;
  managerAgent?: `0x${string}`;
  mode?: RuntimeMode;
  chainId?: number;
}

function normalizePk(raw: string | undefined): `0x${string}` | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  return (trimmed.startsWith("0x") ? trimmed : `0x${trimmed}`) as `0x${string}`;
}

function isOnchainClient(
  client: LacrewClient | OnchainLacrewClient,
): client is OnchainLacrewClient {
  return "publicClient" in client && typeof (client as OnchainLacrewClient).publicClient === "object";
}

/** Build a runtime from env: onchain when ANVIL_RPC + PRIVATE_KEY are present. */
export function createRuntimeFromEnv(): CrewRuntime {
  const rpc = process.env.ANVIL_RPC ?? process.env.RPC_URL;
  const pk = normalizePk(process.env.PRIVATE_KEY);
  if (!rpc || !pk) {
    return new CrewRuntime({ mode: "mock" });
  }

  const chainId = Number(process.env.CHAIN_ID ?? ANVIL_CHAIN_ID);
  const addresses = getAddresses(chainId);
  const managerPk = normalizePk(process.env.MANAGER_PRIVATE_KEY);
  const account = privateKeyToAccount(pk);
  const resolverAccount = managerPk ? privateKeyToAccount(managerPk) : account;

  const client = createOnchainClient({
    transport: http(rpc),
    account,
    resolverAccount,
    chainId,
    addresses,
    indexerPath: process.env.INDEXER_PATH,
  });

  return new CrewRuntime({
    client,
    mode: "onchain",
    chainId,
    workerAgent: addresses.worker ?? MOCK_WORKER,
    spendTarget: addresses.x402Target ?? "0x4444444444444444444444444444444444444444",
    managerAgent: addresses.manager ?? MOCK_MANAGER,
  });
}

export class CrewRuntime {
  private readonly client: LacrewClient | OnchainLacrewClient;
  private readonly workerAgent: `0x${string}`;
  private readonly spendTarget: `0x${string}`;
  private readonly managerAgent: `0x${string}`;
  readonly mode: RuntimeMode;
  readonly chainId: number | null;
  private session: SessionKey | null = null;
  /** Local audit ring for onchain mode (demo works without indexer). */
  private readonly localAudit: ProtocolEvent[] = [];

  constructor(options: CrewRuntimeOptions = {}) {
    this.client = options.client ?? createLacrewClient({ useMock: true });
    this.workerAgent = options.workerAgent ?? MOCK_WORKER;
    this.spendTarget =
      options.spendTarget ?? "0x4444444444444444444444444444444444444444";
    this.managerAgent = options.managerAgent ?? MOCK_MANAGER;
    this.mode = options.mode ?? "mock";
    this.chainId = options.chainId ?? null;
  }

  getClient(): LacrewClient | OnchainLacrewClient {
    return this.client;
  }

  /** Boot (or rotate) a session key for the worker. Onchain: ephemeral key + SessionRegistry. */
  async boot(): Promise<SessionKey> {
    if (this.session && !isSessionExpired(this.session)) {
      return this.session;
    }

    if (isOnchainClient(this.client) && this.addressesHasSessions()) {
      const ephemeral = createEphemeralSession({
        agent: this.workerAgent,
        scopes: ["spend:whitelist", "propose:intent"],
      });
      const maxValue = this.sessionMaxValue();
      const allowedTarget = this.sessionAllowedTarget();
      const { sessionId, txHash } = await this.client.issueSession({
        agent: ephemeral.agent,
        key: ephemeral.keyAddress!,
        expiresAtSec: ephemeral.expiresAtSec,
        scopesHash: ephemeral.scopesHash,
        maxValue,
        allowedTarget,
      });
      // Root sponsors gas so the session key can submit propose (Phase 0; AA/paymaster later).
      const { txHash: fundTxHash } = await this.client.fundEth(
        ephemeral.keyAddress!,
        SESSION_GAS_STIPEND,
      );
      this.session = {
        agent: ephemeral.agent,
        keyId: sessionId,
        keyAddress: ephemeral.keyAddress,
        expiresAt: ephemeral.expiresAt,
        scopes: ephemeral.scopes,
        maxValue: maxValue.toString(),
        allowedTarget,
        revoked: false,
      };
      // Keep private key only on the runtime instance, never in audit payloads.
      (this as { _sessionPk?: `0x${string}` })._sessionPk = ephemeral.privateKey;

      this.pushAudit({
        type: "SessionIssued",
        at: new Date().toISOString(),
        payload: {
          agent: this.session.agent,
          keyId: this.session.keyId,
          keyAddress: this.session.keyAddress,
          expiresAt: this.session.expiresAt,
          maxValue: this.session.maxValue,
          allowedTarget: this.session.allowedTarget,
          txHash,
          fundTxHash,
        },
      });
      return this.session;
    }

    this.session = issueSession({
      agent: this.workerAgent,
      scopes: ["spend:whitelist", "propose:intent"],
    });
    this.pushAudit({
      type: "SessionIssued",
      at: new Date().toISOString(),
      payload: {
        agent: this.session.agent,
        keyId: this.session.keyId,
        expiresAt: this.session.expiresAt,
      },
    });
    return this.session;
  }

  private addressesHasSessions(): boolean {
    return Boolean(
      isOnchainClient(this.client) && this.client.addresses.sessionRegistry,
    );
  }

  /** Ephemeral session account for onchain propose (never logged). */
  private sessionSignerAccount() {
    if (!this.addressesHasSessions()) return undefined;
    const pk = (this as { _sessionPk?: `0x${string}` })._sessionPk;
    if (!pk) {
      throw new Error("Session private key missing; call boot() before tick()");
    }
    return privateKeyToAccount(pk);
  }

  private sessionMaxValue(): bigint {
    const raw = process.env.SESSION_MAX_VALUE?.trim();
    if (raw) return BigInt(raw);
    return DEFAULT_SESSION_MAX_VALUE;
  }

  /** Pin session to spend target (demo default); override with SESSION_ALLOWED_TARGET=0x0 for any. */
  private sessionAllowedTarget(): `0x${string}` {
    const raw = process.env.SESSION_ALLOWED_TARGET?.trim();
    if (raw) return raw as `0x${string}`;
    return this.spendTarget;
  }

  async listSessions(): Promise<SessionKey[]> {
    if (isOnchainClient(this.client)) {
      return this.client.getSessions();
    }
    return this.client.getSessions();
  }

  async revokeSessionById(sessionId: string): Promise<{ txHash?: `0x${string}` }> {
    if (!isOnchainClient(this.client)) {
      if (this.session?.keyId === sessionId) {
        this.session = revokeSession(this.session);
      }
      this.pushAudit({
        type: "SessionRevoked",
        at: new Date().toISOString(),
        payload: { keyId: sessionId, mocked: true },
      });
      return {};
    }
    const { txHash } = await this.client.revokeSession(sessionId);
    if (this.session?.keyId === sessionId) {
      this.session = revokeSession(this.session);
      delete (this as { _sessionPk?: `0x${string}` })._sessionPk;
    }
    this.pushAudit({
      type: "SessionRevoked",
      at: new Date().toISOString(),
      payload: { keyId: sessionId, txHash },
    });
    return { txHash };
  }

  /**
   * Propose a spend intent.
   * Default 75 USDC exceeds the worker 50 USDC cap → ESCALATE to manager.
   */
  async tick(value = 75n * 10n ** 6n): Promise<{
    session: SessionKey;
    intentId: string;
    verdict: string;
    txHash?: `0x${string}`;
  }> {
    const session = await this.boot();
    if (isSessionExpired(session)) {
      this.session = revokeSession(session);
      throw new Error("Session expired; call boot() to rotate");
    }

    const sessionAccount = this.sessionSignerAccount();
    const result = await this.client.proposeIntent({
      agent: this.workerAgent,
      target: this.spendTarget,
      value,
      data: "0x",
      ...(sessionAccount ? { account: sessionAccount } : {}),
    });

    const txHash = "txHash" in result ? result.txHash : undefined;
    if (result.verdict === "ALLOW") {
      this.pushAudit({
        type: "AllowanceSpent",
        at: new Date().toISOString(),
        payload: {
          agent: this.workerAgent,
          target: this.spendTarget,
          value: value.toString(),
          txHash,
        },
      });
    } else if (result.verdict === "ESCALATE") {
      this.pushAudit({
        type: "IntentCreated",
        at: new Date().toISOString(),
        payload: {
          intentId: result.intentId,
          agent: this.workerAgent,
          target: this.spendTarget,
          value: value.toString(),
          awaitingApprover: this.managerAgent,
          txHash,
        },
      });
    }

    if (txHash) await this.ingestReceiptLogs(txHash);

    return {
      session,
      intentId: result.intentId,
      verdict: result.verdict,
      txHash,
    };
  }

  async listPending(): Promise<Intent[]> {
    return this.client.getPendingIntents();
  }

  /** Merge local ring with indexer/mock client trail (local first, newest first). */
  async audit(): Promise<ProtocolEvent[]> {
    const remote = await this.client.getAuditTrail();
    const seen = new Set<string>();
    const out: ProtocolEvent[] = [];
    const keyOf = (e: ProtocolEvent) =>
      `${e.type}:${e.payload.intentId ?? ""}:${e.payload.txHash ?? ""}:${e.payload.value ?? ""}:${e.at}`;

    for (const e of [...this.localAudit].reverse()) {
      const k = keyOf(e);
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(e);
    }
    for (const e of [...remote].reverse()) {
      const k = keyOf(e);
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(e);
    }
    return out;
  }

  /**
   * Manager (or root) resolves a pending intent.
   * Onchain mode signs with resolverAccount (MANAGER_PRIVATE_KEY).
   */
  async resolve(
    intentId: string,
    approved: boolean,
    approver: `0x${string}` = this.managerAgent,
  ): Promise<ResolveResult> {
    const result = await this.client.resolveIntent(intentId, approved, approver);
    const txHash = "txHash" in result ? result.txHash : undefined;

    this.pushAudit({
      type: "IntentResolved",
      at: new Date().toISOString(),
      payload: {
        intentId,
        approved,
        escalated: result.escalated,
        txHash,
      },
    });

    if (txHash) await this.ingestReceiptLogs(txHash);
    return result;
  }

  /** List onchain governance proposals (empty in mock mode). */
  async listProposals(): Promise<GovernanceProposal[]> {
    if (!isOnchainClient(this.client)) return [];
    return this.client.getProposals();
  }

  /**
   * Propose hiring a worker/manager via GovernanceModule → OrgRegistry.addNode.
   * Onchain only.
   */
  async proposeHire(input: {
    label: string;
    kind?: "manager_agent" | "worker_agent";
    parent?: `0x${string}`;
    tier?: GovernanceTier;
  }): Promise<{
    proposalId: string;
    account: `0x${string}`;
    txHash?: `0x${string}`;
  }> {
    if (!isOnchainClient(this.client)) {
      throw new Error("proposeHire requires onchain mode (ANVIL_RPC + PRIVATE_KEY)");
    }
    const result = await this.client.proposeHire(input);
    this.pushAudit({
      type: "ProposalCreated",
      at: new Date().toISOString(),
      payload: {
        proposalId: result.proposalId,
        account: result.account,
        label: input.label,
        kind: input.kind ?? "worker_agent",
        action: "hire",
        txHash: result.txHash,
      },
    });
    return result;
  }

  /** Propose firing a node (OrgRegistry.removeNode — children rewire to parent). */
  async proposeFire(input: {
    account: `0x${string}`;
    tier?: GovernanceTier;
  }): Promise<{ proposalId: string; account: `0x${string}`; txHash?: `0x${string}` }> {
    if (!isOnchainClient(this.client)) {
      throw new Error("proposeFire requires onchain mode (ANVIL_RPC + PRIVATE_KEY)");
    }
    const result = await this.client.proposeFire(input);
    this.pushAudit({
      type: "ProposalCreated",
      at: new Date().toISOString(),
      payload: {
        proposalId: result.proposalId,
        account: result.account,
        action: "fire",
        txHash: result.txHash,
      },
    });
    return result;
  }

  /** Propose reparenting a node under a new manager/root. */
  async proposeReparent(input: {
    account: `0x${string}`;
    newParent: `0x${string}`;
    tier?: GovernanceTier;
  }): Promise<{ proposalId: string; account: `0x${string}`; txHash?: `0x${string}` }> {
    if (!isOnchainClient(this.client)) {
      throw new Error("proposeReparent requires onchain mode (ANVIL_RPC + PRIVATE_KEY)");
    }
    const result = await this.client.proposeReparent(input);
    this.pushAudit({
      type: "ProposalCreated",
      at: new Date().toISOString(),
      payload: {
        proposalId: result.proposalId,
        account: result.account,
        newParent: input.newParent,
        action: "reparent",
        txHash: result.txHash,
      },
    });
    return result;
  }

  /** Propose changing a node's per-epoch grant (high tier by default). */
  async proposeSetGrant(input: {
    account: `0x${string}`;
    amount: bigint;
    tier?: GovernanceTier;
  }): Promise<{ proposalId: string; account: `0x${string}`; txHash?: `0x${string}` }> {
    if (!isOnchainClient(this.client)) {
      throw new Error("proposeSetGrant requires onchain mode (ANVIL_RPC + PRIVATE_KEY)");
    }
    const result = await this.client.proposeSetGrant(input);
    this.pushAudit({
      type: "ProposalCreated",
      at: new Date().toISOString(),
      payload: {
        proposalId: result.proposalId,
        account: result.account,
        amount: input.amount.toString(),
        action: "setGrant",
        txHash: result.txHash,
      },
    });
    return result;
  }

  /**
   * Vote on a proposal. With MANAGER_PRIVATE_KEY set and support=true, also casts
   * the manager seat (DeployMockOrg: root weight 1 + manager weight 1, quorum 2).
   */
  async voteGovernance(
    proposalId: string,
    support: boolean,
  ): Promise<{ txHashes: `0x${string}`[]; proposal: GovernanceProposal }> {
    if (!isOnchainClient(this.client)) {
      throw new Error("voteGovernance requires onchain mode");
    }
    const txHashes: `0x${string}`[] = [];
    const first = await this.client.voteGovernance(proposalId, support);
    txHashes.push(first.txHash);

    // Second seated voter (manager) when available — real weight, not a free-for-all.
    if (
      support &&
      this.client.resolverWalletClient?.account &&
      this.client.walletClient?.account &&
      this.client.resolverWalletClient.account.address.toLowerCase() !==
        this.client.walletClient.account.address.toLowerCase()
    ) {
      try {
        const second = await this.client.voteGovernance(proposalId, true, { useResolver: true });
        txHashes.push(second.txHash);
      } catch {
        // Already voted or no seat — ignore.
      }
    }

    const proposal = await this.client.getProposal(proposalId);
    this.pushAudit({
      type: "ProposalVoted",
      at: new Date().toISOString(),
      payload: {
        proposalId,
        support,
        yesVotes: proposal.yesVotes,
        noVotes: proposal.noVotes,
        txHash: txHashes[txHashes.length - 1],
      },
    });
    return { txHashes, proposal };
  }

  async vetoGovernance(proposalId: string): Promise<{ txHash: `0x${string}`; proposal: GovernanceProposal }> {
    if (!isOnchainClient(this.client)) {
      throw new Error("vetoGovernance requires onchain mode");
    }
    const { txHash } = await this.client.vetoGovernance(proposalId);
    const proposal = await this.client.getProposal(proposalId);
    this.pushAudit({
      type: "ProposalVetoed",
      at: new Date().toISOString(),
      payload: { proposalId, txHash },
    });
    return { txHash, proposal };
  }

  async executeGovernance(
    proposalId: string,
  ): Promise<{ txHash: `0x${string}`; proposal: GovernanceProposal }> {
    if (!isOnchainClient(this.client)) {
      throw new Error("executeGovernance requires onchain mode");
    }
    const { txHash } = await this.client.executeGovernance(proposalId);
    const proposal = await this.client.getProposal(proposalId);
    this.pushAudit({
      type: "ProposalExecuted",
      at: new Date().toISOString(),
      payload: { proposalId, txHash, state: proposal.state },
    });
    return { txHash, proposal };
  }

  /** Run the next payroll epoch (EpochStreamer → Treasury.streamAllowance). */
  async runEpoch(): Promise<{ epoch: number; txHash?: `0x${string}` }> {
    if (!isOnchainClient(this.client)) {
      throw new Error("runEpoch requires onchain mode (ANVIL_RPC + PRIVATE_KEY)");
    }
    const result = await this.client.runEpoch();
    this.pushAudit({
      type: "AllowanceStreamed",
      at: new Date().toISOString(),
      payload: {
        epoch: result.epoch,
        txHash: result.txHash,
        via: "EpochStreamer",
      },
    });
    return result;
  }

  async getCurrentEpoch(): Promise<number> {
    if (!isOnchainClient(this.client)) return 0;
    return this.client.getCurrentEpoch();
  }

  private pushAudit(event: ProtocolEvent): void {
    this.localAudit.push(event);
    if (this.localAudit.length > AUDIT_RING_MAX) {
      this.localAudit.splice(0, this.localAudit.length - AUDIT_RING_MAX);
    }
  }

  /** Parse EscalationRouter logs from a tx receipt into the local audit ring. */
  private async ingestReceiptLogs(txHash: Hex): Promise<void> {
    if (!isOnchainClient(this.client)) return;
    try {
      const receipt = await this.client.publicClient.getTransactionReceipt({ hash: txHash });
      const parsed = parseEventLogs({
        abi: escalationRouterAbi,
        logs: receipt.logs as Log[],
      });
      for (const log of parsed) {
        if (log.eventName === "ActionExecuted") {
          const args = log.args as {
            agent: `0x${string}`;
            target: `0x${string}`;
            value: bigint;
            callOk: boolean;
          };
          this.pushAudit({
            type: "ActionExecuted",
            at: new Date().toISOString(),
            payload: {
              agent: args.agent,
              target: args.target,
              value: args.value.toString(),
              callOk: args.callOk,
              txHash,
            },
          });
        } else if (log.eventName === "IntentCreated") {
          const args = log.args as {
            intentId: bigint;
            agent: `0x${string}`;
            awaitingApprover: `0x${string}`;
          };
          // Already pushed a local IntentCreated; skip duplicate unless missing.
          const exists = this.localAudit.some(
            (e) =>
              e.type === "IntentCreated" &&
              String(e.payload.intentId) === args.intentId.toString() &&
              e.payload.txHash === txHash,
          );
          if (!exists) {
            this.pushAudit({
              type: "IntentCreated",
              at: new Date().toISOString(),
              payload: {
                intentId: args.intentId.toString(),
                agent: args.agent,
                awaitingApprover: args.awaitingApprover,
                txHash,
              },
            });
          }
        } else if (log.eventName === "IntentResolved") {
          const args = log.args as { intentId: bigint; approved: boolean };
          const exists = this.localAudit.some(
            (e) =>
              e.type === "IntentResolved" &&
              String(e.payload.intentId) === args.intentId.toString() &&
              e.payload.txHash === txHash,
          );
          if (!exists) {
            this.pushAudit({
              type: "IntentResolved",
              at: new Date().toISOString(),
              payload: {
                intentId: args.intentId.toString(),
                approved: args.approved,
                txHash,
              },
            });
          }
        } else if (log.eventName === "IntentEscalated") {
          const args = log.args as {
            intentId: bigint;
            from: `0x${string}`;
            to: `0x${string}`;
          };
          this.pushAudit({
            type: "IntentEscalated",
            at: new Date().toISOString(),
            payload: {
              intentId: args.intentId.toString(),
              from: args.from,
              to: args.to,
              txHash,
            },
          });
        }
      }
    } catch {
      // Receipt parse is best-effort for the demo audit ring.
    }
  }
}
