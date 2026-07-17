/**
 * Agent runtime: schedule work, propose intents, listen for events.
 * Defaults to mock SDK; when ANVIL_RPC + PRIVATE_KEY are set, uses createOnchainClient.
 * Onchain mode keeps a local audit ring from propose/resolve receipts so /audit
 * works without a separate indexer process.
 * TODO: BullMQ + Redis scheduling, OpenRouter model calls, MCP tool protocol.
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
  type Intent,
  type ProtocolEvent,
  type SessionKey,
} from "@lacrew/core";
import { http, parseEventLogs, type Hex, type Log } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { issueSession, isSessionExpired, revokeSession } from "./sessions.js";

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

  /** Boot (or rotate) a session key for the worker. */
  async boot(): Promise<SessionKey> {
    if (this.session && !isSessionExpired(this.session)) {
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

    const result = await this.client.proposeIntent({
      agent: this.workerAgent,
      target: this.spendTarget,
      value,
      data: "0x",
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
