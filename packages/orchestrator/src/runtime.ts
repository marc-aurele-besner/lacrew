/**
 * Agent runtime: schedule work, propose intents, listen for events.
 * Defaults to mock SDK; when ANVIL_RPC + PRIVATE_KEY are set, uses createOnchainClient.
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
  getAddresses,
  MOCK_MANAGER,
  MOCK_WORKER,
  type Intent,
  type ProtocolEvent,
  type SessionKey,
} from "@lacrew/core";
import { http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { issueSession, isSessionExpired, revokeSession } from "./sessions.js";

export type RuntimeMode = "mock" | "onchain";

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

    return {
      session,
      intentId: result.intentId,
      verdict: result.verdict,
      txHash: "txHash" in result ? result.txHash : undefined,
    };
  }

  async listPending(): Promise<Intent[]> {
    return this.client.getPendingIntents();
  }

  async audit(): Promise<ProtocolEvent[]> {
    return this.client.getAuditTrail();
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
    return this.client.resolveIntent(intentId, approved, approver);
  }
}
