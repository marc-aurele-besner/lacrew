/**
 * Agent runtime: schedule work, propose intents, listen for events.
 * Defaults to mock SDK; when ANVIL_RPC + PRIVATE_KEY are set, uses createOnchainClient.
 * Onchain mode keeps a local audit ring from propose/resolve receipts so /audit
 * works without a separate indexer process; AuditStore persists it to Postgres.
 * Model access via ModelProvider (memory/OpenRouter); MCP tools bind through
 * createRuntimeMcpBackend. Queue: QueueProvider (pg-boss when DATABASE_URL set).
 */

import {
  createOnchainClient,
  simulateIntentAction,
  type OnchainLacrewClient,
  type ResolveResult,
} from "@lacrew/sdk";
import { createLacrewClient, type LacrewClient } from "@lacrew/sdk/testing";
import {
  ANVIL_CHAIN_ID,
  escalationRouterAbi,
  getAddresses,
  sessionRegistryAbi,
  MOCK_MANAGER,
  MOCK_WORKER,
  SESSION_SCOPES,
  type GovernanceConfig,
  type GovernanceProposal,
  type GovernanceSeat,
  type GovernanceTier,
  type Intent,
  type ProtocolEvent,
  type SessionKey,
  type SessionScope,
} from "@lacrew/core";
import { http, parseEther, parseEventLogs, type Hex, type Log } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { Verdict } from "@lacrew/flows";
import type {
  BudgetActionInput,
  GovernanceActionInput,
  OrgActionInput,
} from "@lacrew/adapter-agents-mcp";
import { issueSession, isSessionExpired, revokeSession, createEphemeralSession } from "./sessions.js";
import { worstVerdict } from "./flowScope.js";
import { sealSessionKey, unsealSessionKey, sessionSealingAvailable } from "./secretBox.js";
import { createAuditStoreFromEnv, createMemoryAuditStore, type AuditStore } from "./auditStore.js";
import {
  createMemoryRuntimeStore,
  createRuntimeStoreFromEnv,
  type IntentRecord,
  type RuntimeStore,
  type SessionRecord,
} from "./runtimeStore.js";

/** Anvil/demo gas stipend so the ephemeral session key can submit propose. */
/** Full authority: what a session gets when the caller does not narrow it. */
const DEFAULT_SESSION_SCOPES: readonly SessionScope[] = SESSION_SCOPES;

/** Order-insensitive comparison, matching how the onchain mask is built. */
function sameScopes(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const left = [...a].sort();
  const right = [...b].sort();
  return left.every((scope, i) => scope === right[i]);
}

/**
 * Gas sponsored to a session key so it can submit `propose` itself.
 *
 * Topped up only when the key is actually short (see `fundSessionKey`). It was
 * previously sent unconditionally on every issue, so a restart of a 20-agent
 * org moved 1 ETH for nothing. Lowered from 0.05 for the same reason: this
 * covers a handful of proposes, and running dry tops up again.
 *
 * Phase 0 — an AA paymaster replaces this entirely.
 */
function sessionGasStipend(): bigint {
  const raw = process.env.SESSION_GAS_STIPEND_ETH?.trim();
  return raw ? parseEther(raw) : parseEther("0.01");
}
/** Default session maxValue: 200 USDC (matches DeployMockOrg worker stream; over policy cap → escalate). */
const DEFAULT_SESSION_MAX_VALUE = 200n * 10n ** 6n;

export type RuntimeMode = "mock" | "onchain";

const AUDIT_RING_MAX = 200;
/** How long a persisted-audit read is reused; the dashboard polls every 3s. */
const AUDIT_STORE_TTL_MS = 2_000;

export interface CrewRuntimeOptions {
  client?: LacrewClient | OnchainLacrewClient;
  workerAgent?: `0x${string}`;
  spendTarget?: `0x${string}`;
  managerAgent?: `0x${string}`;
  mode?: RuntimeMode;
  chainId?: number;
  /** Persistence for the audit ring; defaults to memory no-op. */
  auditStore?: AuditStore;
  /** Persistence for session/intent records; defaults to bounded memory. */
  runtimeStore?: RuntimeStore;
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
    return new CrewRuntime({
      mode: "mock",
      auditStore: createAuditStoreFromEnv(),
      runtimeStore: createRuntimeStoreFromEnv(),
    });
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
    auditStore: createAuditStoreFromEnv(),
    runtimeStore: createRuntimeStoreFromEnv(),
  });
}

export class CrewRuntime {
  private readonly client: LacrewClient | OnchainLacrewClient;
  private readonly workerAgent: `0x${string}`;
  private readonly spendTarget: `0x${string}`;
  private readonly managerAgent: `0x${string}`;
  readonly mode: RuntimeMode;
  readonly chainId: number | null;
  /**
   * Sessions keyed by agent *and* the limits they were issued under. A flow runs
   * as its invoking principal, so a single key can't be shared across agents —
   * the chain binds each key to exactly one agent. Keying on limits too matters
   * for scope ceilings: reusing a cached wide key for a tighter-scoped run would
   * silently hand back the authority the ceiling is supposed to remove.
   * Private keys stay in this map and never reach the store or audit payloads.
   */
  private readonly sessions = new Map<
    string,
    { session: SessionKey; privateKey?: `0x${string}` }
  >();
  /** agent (lowercased) => scopes last explicitly requested for it. */
  private readonly sessionScopePolicy = new Map<string, SessionScope[]>();
  /** Local audit ring for onchain mode (demo works without indexer). */
  private readonly localAudit: ProtocolEvent[] = [];
  private auditCache: { events: ProtocolEvent[]; at: number } | undefined;
  private readonly auditStore: AuditStore;
  private readonly runtimeStore: RuntimeStore;

  constructor(options: CrewRuntimeOptions = {}) {
    this.client = options.client ?? createLacrewClient({ useMock: true });
    this.workerAgent = options.workerAgent ?? MOCK_WORKER;
    this.spendTarget =
      options.spendTarget ?? "0x4444444444444444444444444444444444444444";
    this.managerAgent = options.managerAgent ?? MOCK_MANAGER;
    this.mode = options.mode ?? "mock";
    this.chainId = options.chainId ?? null;
    this.auditStore = options.auditStore ?? createMemoryAuditStore();
    this.runtimeStore = options.runtimeStore ?? createMemoryRuntimeStore();
  }

  /** Replay persisted audit events into the local ring (call once on boot). */
  async hydrateAudit(): Promise<number> {
    const persisted = await this.auditStore.recent(AUDIT_RING_MAX);
    if (persisted.length === 0) return 0;
    this.localAudit.unshift(...persisted);
    if (this.localAudit.length > AUDIT_RING_MAX) {
      this.localAudit.splice(0, this.localAudit.length - AUDIT_RING_MAX);
    }
    return persisted.length;
  }

  /**
   * Restore sealed session keys so a restart reuses live onchain sessions
   * instead of issuing (and gas-funding) replacements. Call once on boot.
   *
   * **The chain is authoritative.** Every candidate is confirmed against
   * `SessionRegistry.keyLimits` before it is trusted, so a session revoked or
   * expired while this process was down is dropped rather than resurrected —
   * a stale local entry would otherwise sign against authority the chain has
   * already taken away.
   *
   * Returns the number restored. Zero is normal and not an error: sealing may
   * be unconfigured, the store may be empty, or every session may have aged out.
   */
  async hydrateSessions(): Promise<number> {
    if (!sessionSealingAvailable()) return 0;
    if (!isOnchainClient(this.client) || !this.addressesHasSessions()) return 0;

    const persisted = await this.runtimeStore.recentSessions(AUDIT_RING_MAX);
    let restored = 0;

    for (const row of persisted) {
      if (row.status !== "active" || !row.keyAddress) continue;
      const privateKey = unsealSessionKey(row.sealedKey);
      if (!privateKey) continue;

      // The key must actually be the one the chain knows about; a mismatch
      // means the row and the envelope disagree and neither can be trusted.
      let derived: `0x${string}`;
      try {
        derived = privateKeyToAccount(privateKey).address;
      } catch {
        continue;
      }
      if (derived.toLowerCase() !== row.keyAddress.toLowerCase()) continue;

      const limits = await this.readKeyLimits(row.agent as `0x${string}`, derived);
      if (!limits?.valid) continue;

      const session: SessionKey = {
        agent: row.agent as `0x${string}`,
        keyId: row.keyId,
        keyAddress: derived,
        expiresAt: new Date(row.expiresAt).getTime(),
        scopes: row.scopes as SessionScope[],
        // Limits come from the chain, not the row: the chain is what enforces
        // them, and the row could be stale.
        maxValue: limits.maxValue.toString(),
        allowedTarget: limits.allowedTarget,
        revoked: false,
      };
      if (isSessionExpired(session)) continue;

      // Top up if the key has spent down since it was issued. Reuse removed the
      // implicit refill that re-issuing used to provide, so without this a
      // long-lived key eventually runs dry and its proposes fail for want of
      // gas rather than for any policy reason.
      try {
        await this.fundSessionKey(derived);
      } catch (err) {
        // A funding failure must not cost us the key: it is still valid and
        // may well have enough gas already.
        console.error(
          "[@lacrew/orchestrator] session key top-up failed:",
          err instanceof Error ? err.message.split("\n")[0] : err,
        );
      }

      this.sessions.set(
        this.sessionCacheKey(session.agent, limits.maxValue, limits.allowedTarget),
        { session, privateKey },
      );
      restored += 1;
    }
    return restored;
  }

  /**
   * Top the session key up to the stipend, but only when it is short.
   *
   * The transfer used to be unconditional on every issue, so re-issuing an
   * already-funded key moved ETH for nothing — and with a key reused across
   * restarts, that would now be most calls. Returns the funding tx hash, or
   * undefined when no transfer was needed.
   */
  private async fundSessionKey(keyAddress: `0x${string}`): Promise<Hex | undefined> {
    if (!isOnchainClient(this.client)) return undefined;
    const stipend = sessionGasStipend();
    try {
      const balance = await this.client.publicClient.getBalance({ address: keyAddress });
      if (balance >= stipend) return undefined;
    } catch {
      // Balance unreadable: fund anyway. An unfunded key cannot propose at all,
      // which is a worse failure than a redundant transfer.
    }
    const { txHash } = await this.client.fundEth(keyAddress, stipend);
    return txHash;
  }

  /** `SessionRegistry.keyLimits`, or null when it cannot be read. */
  private async readKeyLimits(
    agent: `0x${string}`,
    key: `0x${string}`,
  ): Promise<{ valid: boolean; maxValue: bigint; allowedTarget: `0x${string}` } | null> {
    if (!isOnchainClient(this.client)) return null;
    const registry = this.client.addresses.sessionRegistry;
    if (!registry) return null;
    try {
      const [valid, maxValue, allowedTarget] = (await this.client.publicClient.readContract({
        address: registry,
        abi: sessionRegistryAbi,
        functionName: "keyLimits",
        args: [agent, key],
      })) as [boolean, bigint, `0x${string}`, bigint];
      return { valid, maxValue, allowedTarget };
    } catch {
      return null;
    }
  }

  getClient(): LacrewClient | OnchainLacrewClient {
    return this.client;
  }

  /**
   * Boot (or rotate) a session key for `agent` (default: the crew worker).
   * Onchain: ephemeral key + SessionRegistry.
   */
  async boot(
    agent?: `0x${string}`,
    /** Upper bound for this session's maxValue (a flow's scope ceiling). */
    limits?: {
      maxValue?: bigint;
      allowedTarget?: `0x${string}`;
      /** What the key may do. Defaults to the full vocabulary. */
      scopes?: SessionScope[];
    },
  ): Promise<SessionKey> {
    const forAgent = agent ?? this.workerAgent;
    const ceiling = limits?.maxValue;
    // An explicit narrowing sticks until it is explicitly changed. Internal
    // callers (propose, purchase) boot without scopes, so defaulting to the
    // full set here would silently re-widen an agent on the next action and
    // make narrowing unobservable outside the one call that asked for it.
    const scopes = limits?.scopes ?? this.scopePolicyFor(forAgent);
    if (limits?.scopes) this.sessionScopePolicy.set(forAgent.toLowerCase(), limits.scopes);
    const key = this.sessionCacheKey(forAgent, ceiling, limits?.allowedTarget);
    const held = this.sessions.get(key);
    // A cached session is only reusable when its scopes match what was asked
    // for. Reusing a wider one would hand back authority this call did not
    // request, which is the failure the scopes exist to prevent.
    if (held && !isSessionExpired(held.session) && sameScopes(held.session.scopes, scopes)) {
      return held.session;
    }

    if (isOnchainClient(this.client) && this.addressesHasSessions()) {
      const ephemeral = createEphemeralSession({ agent: forAgent, scopes });
      // The chain enforces maxValue on every propose, so the ceiling becomes a
      // real limit rather than a check the orchestrator has to remember.
      const maxValue =
        ceiling === undefined
          ? this.sessionMaxValue()
          : ceiling < this.sessionMaxValue()
            ? ceiling
            : this.sessionMaxValue();
      const allowedTarget = limits?.allowedTarget ?? this.sessionAllowedTarget();
      const { sessionId, txHash } = await this.client.issueSession({
        agent: ephemeral.agent,
        key: ephemeral.keyAddress!,
        expiresAtSec: ephemeral.expiresAtSec,
        scopeMask: ephemeral.scopeMask,
        maxValue,
        allowedTarget,
      });
      // Root sponsors gas so the session key can submit propose (Phase 0; AA/paymaster later).
      const fundTxHash = await this.fundSessionKey(ephemeral.keyAddress!);
      const session: SessionKey = {
        agent: ephemeral.agent,
        keyId: sessionId,
        keyAddress: ephemeral.keyAddress,
        expiresAt: ephemeral.expiresAt,
        scopes: ephemeral.scopes,
        maxValue: maxValue.toString(),
        allowedTarget,
        revoked: false,
      };
      this.sessions.set(key, { session, privateKey: ephemeral.privateKey });
      // Awaited: this is the only durable copy of a key that just cost gas.
      await this.recordSession(session, ephemeral.privateKey);

      this.pushAudit({
        type: "SessionIssued",
        at: new Date().toISOString(),
        payload: {
          agent: session.agent,
          keyId: session.keyId,
          keyAddress: session.keyAddress,
          expiresAt: session.expiresAt,
          maxValue: session.maxValue,
          allowedTarget: session.allowedTarget,
          scopes: session.scopes,
          txHash,
          fundTxHash,
        },
      });
      return session;
    }

    const session = issueSession({ agent: forAgent, scopes });
    this.sessions.set(key, { session });
    // No key exists on this path, so nothing is lost by not waiting.
    void this.recordSession(session);
    this.pushAudit({
      type: "SessionIssued",
      at: new Date().toISOString(),
      payload: {
        agent: session.agent,
        keyId: session.keyId,
        expiresAt: session.expiresAt,
        scopes: session.scopes,
      },
    });
    return session;
  }

  /** Scopes an agent was last explicitly booted with; full set until narrowed. */
  private scopePolicyFor(agent: `0x${string}`): SessionScope[] {
    return this.sessionScopePolicy.get(agent.toLowerCase()) ?? [...DEFAULT_SESSION_SCOPES];
  }

  /** Distinct limit sets need distinct keys; see the `sessions` map comment. */
  private sessionCacheKey(
    agent: `0x${string}`,
    maxValue?: bigint,
    allowedTarget?: `0x${string}`,
  ): string {
    // The target is part of the key for the same reason maxValue is: a cached key
    // pinned to a different target would either be rejected onchain or, worse,
    // hand back reach the caller's scope was not granted.
    const target = (allowedTarget ?? this.sessionAllowedTarget()).toLowerCase();
    // Both sides are resolved to what the session is actually issued with. An
    // unspecified ceiling used to key as the literal "default", so a boot with
    // no ceiling and a boot with a ceiling equal to the default — identical
    // sessions onchain — landed in two cache entries, and the second issued a
    // redundant session (and paid gas for it) to say the same thing.
    const ceiling = maxValue ?? this.sessionMaxValue();
    return `${agent.toLowerCase()}:${ceiling.toString()}:${target}`;
  }

  /**
   * The session maxValue a run should get: the smaller of the principal's own
   * spend cap and the scope's. Undefined when there is no ceiling to apply or
   * no SpendCapPolicy to read.
   */
  async ceilingMaxValue(
    principal: `0x${string}`,
    ceiling?: `0x${string}`,
  ): Promise<bigint | undefined> {
    if (!ceiling || ceiling.toLowerCase() === principal.toLowerCase()) return undefined;
    if (!isOnchainClient(this.client)) return undefined;
    const [own, scoped] = await Promise.all([
      this.client.capOf(principal),
      this.client.capOf(ceiling),
    ]);
    if (own === undefined || scoped === undefined) return undefined;
    return own <= scoped ? own : scoped;
  }

  private addressesHasSessions(): boolean {
    return Boolean(
      isOnchainClient(this.client) && this.client.addresses.sessionRegistry,
    );
  }

  /** Ephemeral session account for `agent`'s onchain propose (never logged). */
  private sessionSignerAccount(
    agent?: `0x${string}`,
    maxValue?: bigint,
    allowedTarget?: `0x${string}`,
  ) {
    if (!this.addressesHasSessions()) return undefined;
    const key = this.sessionCacheKey(agent ?? this.workerAgent, maxValue, allowedTarget);
    const pk = this.sessions.get(key)?.privateKey;
    if (!pk) {
      throw new Error(
        `Session private key missing for ${agent ?? this.workerAgent}; call boot() first`,
      );
    }
    return privateKeyToAccount(pk);
  }

  /** Locate a held session by its onchain id, across every agent. */
  private findSessionEntry(sessionId: string): [string, { session: SessionKey }] | undefined {
    for (const [key, held] of this.sessions) {
      if (held.session.keyId === sessionId) return [key, held];
    }
    return undefined;
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
      const held = this.findSessionEntry(sessionId);
      if (held) {
        this.sessions.set(held[0], { session: revokeSession(held[1].session) });
      }
      void this.runtimeStore.markSessionRevoked(sessionId, new Date().toISOString());
      this.pushAudit({
        type: "SessionRevoked",
        at: new Date().toISOString(),
        payload: { keyId: sessionId, mocked: true },
      });
      return {};
    }
    const { txHash } = await this.client.revokeSession(sessionId);
    const held = this.findSessionEntry(sessionId);
    if (held) {
      // Drop the private key with the session; a revoked key must not sign again.
      this.sessions.set(held[0], { session: revokeSession(held[1].session) });
    }
    void this.runtimeStore.markSessionRevoked(sessionId, new Date().toISOString());
    this.pushAudit({
      type: "SessionRevoked",
      at: new Date().toISOString(),
      payload: { keyId: sessionId, txHash },
    });
    return { txHash };
  }

  /**
   * Propose a spend intent for any agent/target (defaults: the crew worker →
   * configured spend target). Session-signed onchain; the chain enforces that
   * the session key actually belongs to `agent`.
   */
  async propose(input: {
    agent?: `0x${string}`;
    target?: `0x${string}`;
    value: bigint;
    /** Flow scope ceiling; caps the session key the chain will enforce. */
    ceiling?: `0x${string}`;
  }): Promise<{
    session: SessionKey;
    intentId: string;
    verdict: string;
    txHash?: `0x${string}`;
  }> {
    const agent = input.agent ?? this.workerAgent;
    const target = input.target ?? this.spendTarget;
    const value = input.value;

    const ceilingValue = await this.ceilingMaxValue(agent, input.ceiling);
    const session = await this.boot(agent, { maxValue: ceilingValue });
    if (isSessionExpired(session)) {
      this.sessions.set(this.sessionCacheKey(agent, ceilingValue), {
        session: revokeSession(session),
      });
      throw new Error("Session expired; call boot() to rotate");
    }

    const sessionAccount = this.sessionSignerAccount(agent, ceilingValue);
    const result = await this.client.proposeIntent({
      agent,
      target,
      value,
      data: "0x",
      ...(sessionAccount ? { account: sessionAccount } : {}),
    });

    const txHash = "txHash" in result ? result.txHash : undefined;
    void this.runtimeStore.saveIntent({
      intentId: result.intentId,
      agent,
      target,
      value: value.toString(),
      verdict: result.verdict,
      status:
        result.verdict === "ALLOW"
          ? "executed"
          : result.verdict === "ESCALATE"
            ? "pending"
            : "denied",
      txHash,
      sessionKeyId: session.keyId,
      chainId: this.chainId ?? undefined,
      proposedAt: new Date().toISOString(),
    });
    if (result.verdict === "ALLOW") {
      this.pushAudit({
        type: "AllowanceSpent",
        at: new Date().toISOString(),
        payload: {
          agent,
          target,
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
          agent,
          target,
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

  /**
   * Demo heartbeat: propose the default crew spend.
   * Default 75 USDC exceeds the worker 50 USDC cap → ESCALATE to manager.
   */
  async tick(value = 75n * 10n ** 6n): Promise<{
    session: SessionKey;
    intentId: string;
    verdict: string;
    txHash?: `0x${string}`;
  }> {
    return this.propose({ value });
  }

  async listPending(): Promise<Intent[]> {
    const intents = await this.client.getPendingIntents();
    const unsimulated = intents.filter((i) => !i.simulation);
    if (unsimulated.length === 0) return intents;

    // Onchain: enrich with real allowance state + a dry-run of the approval
    // (eth_call through resolve → finalize → the agent's target call).
    const onchain = isOnchainClient(this.client) ? this.client : null;
    const allowances = onchain ? await onchain.getAllowances().catch(() => []) : [];
    const balanceOf = (agent: string) =>
      allowances.find((a) => a.node.toLowerCase() === agent.toLowerCase())?.balance;

    return Promise.all(
      intents.map(async (intent) => {
        if (intent.simulation) return intent;
        const simulation = simulateIntentAction({
          agent: intent.agent,
          target: intent.target,
          value: intent.value,
          verdict: intent.verdict,
          allowanceBalance: balanceOf(intent.agent),
        });
        if (onchain) {
          const approval = await onchain
            .simulateResolveApproval(intent.id)
            .catch(() => null);
          if (approval && !approval.ok) {
            simulation.status = "revert";
            simulation.warnings.push(
              `Approval dry-run reverted: ${approval.reason ?? "unknown"}`,
            );
          } else if (approval?.ok) {
            simulation.warnings.push("Approval dry-run succeeded (eth_call).");
          }
        }
        return { ...intent, simulation };
      }),
    );
  }

  /**
   * Merge the local ring, the persisted store, and the client's trail
   * (local first, newest first).
   *
   * The persisted store is read here and not only in `hydrateAudit`, because
   * the indexer writes chain events into the same table from a separate
   * process. Reading it once at boot meant anything indexed afterwards stayed
   * invisible until the orchestrator restarted — so an approval that settled
   * onchain a minute ago was missing from the trail that is supposed to prove
   * it happened. Cached briefly since the dashboard polls this every 3s.
   */
  async audit(): Promise<ProtocolEvent[]> {
    const [remote, persisted] = await Promise.all([
      this.client.getAuditTrail(),
      this.recentPersistedAudit(),
    ]);
    const seen = new Set<string>();
    const out: ProtocolEvent[] = [];
    const keyOf = (e: ProtocolEvent) =>
      `${e.type}:${e.payload.intentId ?? ""}:${e.payload.txHash ?? ""}:${e.payload.value ?? ""}:${e.at}`;

    const take = (events: ProtocolEvent[]) => {
      for (const e of events) {
        const k = keyOf(e);
        if (seen.has(k)) continue;
        seen.add(k);
        out.push(e);
      }
    };

    take([...this.localAudit].reverse());
    take(persisted);
    take([...remote].reverse());
    return out;
  }

  /** Persisted trail, newest first, cached for AUDIT_STORE_TTL_MS. */
  private async recentPersistedAudit(): Promise<ProtocolEvent[]> {
    const now = Date.now();
    if (this.auditCache && now - this.auditCache.at < AUDIT_STORE_TTL_MS) {
      return this.auditCache.events;
    }
    try {
      const events = await this.auditStore.recent(AUDIT_RING_MAX);
      // `recent` returns oldest-first; this merge is newest-first throughout.
      const ordered = [...events].reverse();
      this.auditCache = { events: ordered, at: now };
      return ordered;
    } catch {
      // A store blip must not empty a trail the local ring can still answer.
      return this.auditCache?.events ?? [];
    }
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

    // Escalated intents climbed the tree and are still pending upstream.
    if (!result.escalated) {
      void this.runtimeStore.markIntentResolved(intentId, {
        status: approved ? "approved" : "denied",
        resolveTxHash: txHash,
        resolvedAt: new Date().toISOString(),
      });
    }

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

  /** List governance proposals (mock client keeps an in-memory register). */
  async listProposals(): Promise<GovernanceProposal[]> {
    return this.client.getProposals();
  }

  /**
   * The electorate: who may vote, with what weight and seat class, plus the
   * quorum thresholds `execute()` actually gates on.
   *
   * Weight is enforced onchain — `votingPower[voter]` is read by `vote()` and a
   * zero-weight address reverts — so this is a read, never a policy this
   * process decides. Consumers that display a quorum should use these numbers
   * rather than the contract's deployed defaults, which are mutable by the root.
   */
  async listElectorate(): Promise<{
    seats: GovernanceSeat[];
    config: GovernanceConfig;
    mode: RuntimeMode;
  }> {
    const client = this.client as {
      readGovernanceSeats?: (opts?: unknown) => Promise<GovernanceSeat[]>;
      readGovernanceConfig?: () => Promise<GovernanceConfig>;
    };
    if (!client.readGovernanceSeats || !client.readGovernanceConfig) {
      throw new Error("electorate_unsupported_by_client");
    }
    const [seats, config] = await Promise.all([
      client.readGovernanceSeats(),
      client.readGovernanceConfig(),
    ]);
    return { seats, config, mode: this.mode };
  }

  /** Propose hiring a worker/manager via GovernanceModule → OrgRegistry.addNode. */
  // ——— Marketplace ———

  /**
   * Price and split for a listing, read from MarketplacePayments.
   *
   * Returns `listed: false` in mock mode or when the catalog id has no onchain
   * listing, so callers can show a catalog entry as browsable-but-not-buyable
   * rather than inventing a price the chain would not honour.
   */
  async marketplaceQuote(catalogId: string): Promise<{
    listed: boolean;
    gross: string;
    fee: string;
    net: string;
    feeBps: number;
    seller?: `0x${string}`;
    active?: boolean;
  }> {
    if (!isOnchainClient(this.client)) {
      return { listed: false, gross: "0", fee: "0", net: "0", feeBps: 0 };
    }
    try {
      const listing = await this.client.getListing(catalogId);
      if (!listing) return { listed: false, gross: "0", fee: "0", net: "0", feeBps: 0 };
      const q = await this.client.quoteListing(catalogId);
      return {
        listed: true,
        gross: q.gross.toString(),
        fee: q.fee.toString(),
        net: q.net.toString(),
        feeBps: q.feeBps,
        seller: listing.seller,
        active: listing.active,
      };
    } catch {
      // No MarketplacePayments deployed on this chain.
      return { listed: false, gross: "0", fee: "0", net: "0", feeBps: 0 };
    }
  }

  async marketplaceEntitlement(
    catalogId: string,
    buyer: `0x${string}`,
  ): Promise<{ purchased: boolean }> {
    if (!isOnchainClient(this.client)) return { purchased: false };
    try {
      return { purchased: await this.client.hasPurchased(catalogId, buyer) };
    } catch {
      return { purchased: false };
    }
  }

  /**
   * Buy a listing with org funds. This is an ordinary policy-checked intent, so
   * an over-cap purchase comes back `ESCALATE` and pays nobody until a human
   * approves — callers must not treat anything but `ALLOW` as a completed buy.
   */
  async marketplacePurchase(input: {
    catalogId: string;
    agent: `0x${string}`;
    buyer?: `0x${string}`;
  }): Promise<{
    intentId: string;
    verdict: string;
    txHash?: `0x${string}`;
    gross: string;
    fee: string;
    net: string;
  }> {
    if (!isOnchainClient(this.client)) {
      throw new Error("marketplace_purchase_requires_chain");
    }
    // The router only accepts a propose signed by a live session key for the
    // paying agent, so ensure one exists and sign with it — the root wallet is
    // not a session and would be rejected.
    const quote = await this.client.quoteListing(input.catalogId);
    const market = this.client.addresses.marketplacePayments;
    if (!market) throw new Error("marketplace_not_deployed");

    // Session keys are pinned to one target, so the default (x402) key cannot
    // reach the marketplace. Issue one scoped to the marketplace and to exactly
    // this listing's price — the chain then caps the purchase at what was quoted.
    await this.boot(input.agent, { maxValue: quote.gross, allowedTarget: market });
    const result = await this.client.proposeMarketplacePurchase({
      agent: input.agent,
      catalogId: input.catalogId,
      buyer: input.buyer,
      account: this.sessionSignerAccount(input.agent, quote.gross, market),
    });
    this.pushAudit({
      type: "MarketplacePurchase",
      at: new Date().toISOString(),
      payload: {
        catalogId: input.catalogId,
        agent: input.agent,
        buyer: input.buyer ?? input.agent,
        intentId: result.intentId,
        verdict: result.verdict,
        gross: result.gross.toString(),
        fee: result.fee.toString(),
        txHash: result.txHash,
      },
    });
    return {
      intentId: result.intentId,
      verdict: result.verdict,
      txHash: result.txHash,
      gross: result.gross.toString(),
      fee: result.fee.toString(),
      net: result.net.toString(),
    };
  }

  /**
   * Register (or reprice) a listing on MarketplacePayments.
   *
   * The seller is bound to the wallet that signs this, so a listing published
   * through a self-hosted orchestrator accrues to that operator's own address —
   * the cloud cannot redirect a seller's earnings to itself.
   */
  async marketplaceRegister(input: { catalogId: string; price: string }): Promise<{
    listingId: string;
    seller: string;
    price: string;
    txHash?: `0x${string}`;
  }> {
    if (!isOnchainClient(this.client)) {
      throw new Error("marketplace_requires_chain");
    }
    const price = BigInt(input.price);
    if (price < 0n) throw new Error("price_must_be_non_negative");
    const { txHash, listingId } = await this.client.registerListing({
      catalogId: input.catalogId,
      price,
    });
    const seller = this.client.walletClient?.account?.address ?? "";
    this.pushAudit({
      type: "MarketplaceListed",
      at: new Date().toISOString(),
      payload: { catalogId: input.catalogId, listingId, seller, price: input.price, txHash },
    });
    return { listingId, seller, price: input.price, txHash };
  }

  /** Balance accrued to a seller (or the platform) awaiting withdrawal. */
  async marketplaceEarnings(payee: `0x${string}`): Promise<{ owed: string }> {
    if (!isOnchainClient(this.client)) return { owed: "0" };
    try {
      return { owed: (await this.client.marketplaceEarnings(payee)).toString() };
    } catch {
      return { owed: "0" };
    }
  }

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
        txHash: "txHash" in result ? result.txHash : undefined,
      },
    });
    return result;
  }

  /** Propose firing a node (OrgRegistry.removeNode — children rewire to parent). */
  async proposeFire(input: {
    account: `0x${string}`;
    tier?: GovernanceTier;
  }): Promise<{ proposalId: string; account: `0x${string}`; txHash?: `0x${string}` }> {
    const result = await this.client.proposeFire(input);
    this.pushAudit({
      type: "ProposalCreated",
      at: new Date().toISOString(),
      payload: {
        proposalId: result.proposalId,
        account: result.account,
        action: "fire",
        txHash: "txHash" in result ? result.txHash : undefined,
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
    const result = await this.client.proposeReparent(input);
    this.pushAudit({
      type: "ProposalCreated",
      at: new Date().toISOString(),
      payload: {
        proposalId: result.proposalId,
        account: result.account,
        newParent: input.newParent,
        action: "reparent",
        txHash: "txHash" in result ? result.txHash : undefined,
      },
    });
    return result;
  }

  /**
   * Propose suspending or restoring a node (OrgRegistry.setActive). Reversible,
   * unlike proposeFire's removeNode, which also rewires children to the parent.
   */
  async proposeSetActive(input: {
    account: `0x${string}`;
    active: boolean;
    tier?: GovernanceTier;
  }): Promise<{ proposalId: string; account: `0x${string}`; txHash?: `0x${string}` }> {
    const result = await this.client.proposeSetActive(input);
    this.pushAudit({
      type: "ProposalCreated",
      at: new Date().toISOString(),
      payload: {
        proposalId: result.proposalId,
        account: result.account,
        action: input.active ? "activate" : "deactivate",
        txHash: "txHash" in result ? result.txHash : undefined,
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
    const result = await this.client.proposeSetGrant(input);
    this.pushAudit({
      type: "ProposalCreated",
      at: new Date().toISOString(),
      payload: {
        proposalId: result.proposalId,
        account: result.account,
        amount: input.amount.toString(),
        action: "setGrant",
        txHash: "txHash" in result ? result.txHash : undefined,
      },
    });
    return result;
  }

  async proposeSetNodePolicy(input: {
    node: `0x${string}`;
    policyModule: `0x${string}`;
    tier?: GovernanceTier;
  }): Promise<{ proposalId: string; node: `0x${string}`; txHash?: `0x${string}` }> {
    if (!isOnchainClient(this.client)) {
      throw new Error("proposeSetNodePolicy requires onchain mode");
    }
    const result = await this.client.proposeSetNodePolicy(input);
    this.pushAudit({
      type: "ProposalCreated",
      at: new Date().toISOString(),
      payload: {
        proposalId: result.proposalId,
        node: result.node,
        policyModule: input.policyModule,
        action: "setNodePolicy",
        txHash: result.txHash,
      },
    });
    return result;
  }

  async proposeSetWhitelist(input: {
    target: `0x${string}`;
    allowed: boolean;
    tier?: GovernanceTier;
  }): Promise<{ proposalId: string; target: `0x${string}`; txHash?: `0x${string}` }> {
    if (!isOnchainClient(this.client)) {
      throw new Error("proposeSetWhitelist requires onchain mode");
    }
    const result = await this.client.proposeSetWhitelist(input);
    this.pushAudit({
      type: "ProposalCreated",
      at: new Date().toISOString(),
      payload: {
        proposalId: result.proposalId,
        target: result.target,
        allowed: input.allowed,
        action: "setWhitelist",
        txHash: result.txHash,
      },
    });
    return result;
  }

  async proposeSetAgentCap(input: {
    agent: `0x${string}`;
    cap: bigint;
    tier?: GovernanceTier;
  }): Promise<{ proposalId: string; agent: `0x${string}`; txHash?: `0x${string}` }> {
    if (!isOnchainClient(this.client)) {
      throw new Error("proposeSetAgentCap requires onchain mode");
    }
    const result = await this.client.proposeSetAgentCap(input);
    this.pushAudit({
      type: "ProposalCreated",
      at: new Date().toISOString(),
      payload: {
        proposalId: result.proposalId,
        agent: result.agent,
        cap: input.cap.toString(),
        action: "setAgentCap",
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
      await this.client.voteGovernance(proposalId, support);
      const proposal = await this.client.getProposal(proposalId);
      this.pushAudit({
        type: "ProposalVoted",
        at: new Date().toISOString(),
        payload: {
          proposalId,
          support,
          yesVotes: proposal.yesVotes,
          noVotes: proposal.noVotes,
        },
      });
      return { txHashes: [], proposal };
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

  async vetoGovernance(proposalId: string): Promise<{ txHash?: `0x${string}`; proposal: GovernanceProposal }> {
    if (!isOnchainClient(this.client)) {
      const { proposal } = await this.client.vetoGovernance(proposalId);
      this.pushAudit({
        type: "ProposalVetoed",
        at: new Date().toISOString(),
        payload: { proposalId },
      });
      return { proposal };
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
  ): Promise<{ txHash?: `0x${string}`; proposal: GovernanceProposal }> {
    if (!isOnchainClient(this.client)) {
      const { proposal } = await this.client.executeGovernance(proposalId);
      this.pushAudit({
        type: "ProposalExecuted",
        at: new Date().toISOString(),
        payload: { proposalId, state: proposal.state },
      });
      return { proposal };
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

  /** Run the next payroll epoch (EpochStreamer onchain; mock streams caps). */
  async runEpoch(): Promise<{ epoch: number; txHash?: `0x${string}` }> {
    const result = await this.client.runEpoch();
    this.pushAudit({
      type: "AllowanceStreamed",
      at: new Date().toISOString(),
      payload: {
        epoch: result.epoch,
        txHash: "txHash" in result ? result.txHash : undefined,
        via: "EpochStreamer",
      },
    });
    return result;
  }

  async getCurrentEpoch(): Promise<number> {
    return this.client.getCurrentEpoch();
  }

  /**
   * Read a verdict without proposing anything. Mock mode has no policy module
   * to read, so it mirrors the mock client's own spend rule.
   */
  async checkPolicy(input: {
    agent: `0x${string}`;
    target: `0x${string}`;
    value: bigint;
    data?: `0x${string}`;
    policyModule?: `0x${string}`;
  }): Promise<{ verdict: Verdict }> {
    if (!isOnchainClient(this.client)) {
      return { verdict: input.value > DEFAULT_SESSION_MAX_VALUE ? "ESCALATE" : "ALLOW" };
    }
    const verdict = await this.client.checkPolicy(input);
    return { verdict: verdict as Verdict };
  }

  /**
   * The module that answers "how much authority does this agent have?".
   *
   * Org and budget actions are not spends: the target is a node, not a payee.
   * Running them through the full PolicyStack would consult WhitelistPolicy,
   * which DENIES every address that is not a configured spend target — so every
   * budget raise would read as denied for a reason unrelated to authority.
   * SpendCapPolicy is the meaningful signal: within cap → low tier, over cap →
   * escalate to a timelocked proposal.
   */
  private authorityPolicyModule(): `0x${string}` | undefined {
    if (!isOnchainClient(this.client)) return undefined;
    return this.client.addresses.spendCapPolicy;
  }

  /**
   * Effective verdict for an action run by `agent` under a flow scoped to
   * `ceiling`: the stricter of the two policy stacks. The chain enforces the
   * agent's own stack; the ceiling is this process's additional cap.
   */
  async checkEffectivePolicy(input: {
    agent: `0x${string}`;
    ceiling?: `0x${string}`;
    target: `0x${string}`;
    value: bigint;
    data?: `0x${string}`;
    policyModule?: `0x${string}`;
  }): Promise<{ verdict: Verdict; capped: boolean }> {
    const { agent, ceiling, ...rest } = input;
    const own = (await this.checkPolicy({ agent, ...rest })).verdict;
    if (!ceiling || ceiling.toLowerCase() === agent.toLowerCase()) {
      return { verdict: own, capped: false };
    }
    const scoped = (await this.checkPolicy({ agent: ceiling, ...rest })).verdict;
    const effective = worstVerdict(own, scoped);
    return { verdict: effective, capped: effective !== own };
  }

  /**
   * Change the org chart or an agent's properties on behalf of a flow.
   *
   * Org structure is constitutional, so every change is a governance proposal —
   * the orchestrator holds session keys only and must never be able to rewrite
   * the chart directly. The policy verdict picks the tier instead of
   * proposal-vs-write: ALLOW earns Low tier (executes on quorum, no timelock),
   * ESCALATE gets High tier (timelock + human veto), DENY raises nothing.
   */
  async orgAction(
    input: OrgActionInput & { principal?: `0x${string}`; ceiling?: `0x${string}` },
  ): Promise<{ verdict: Verdict; proposalId?: string; txHash?: `0x${string}` }> {
    const agent = input.principal ?? this.workerAgent;
    const { verdict } = await this.checkEffectivePolicy({
      agent,
      ceiling: input.ceiling,
      target: input.node ?? input.parent ?? this.spendTarget,
      value: input.cap ?? 0n,
      policyModule: this.authorityPolicyModule(),
    });
    if (verdict === "DENY") return { verdict };

    const tier: GovernanceTier = verdict === "ALLOW" ? "low" : "high";
    switch (input.action) {
      case "hire": {
        const r = await this.proposeHire({
          label: input.label ?? "flow-hire",
          parent: input.parent!,
          kind: input.nodeKind ?? "worker_agent",
          tier,
        });
        return { verdict, proposalId: r.proposalId, txHash: r.txHash };
      }
      case "fire": {
        const r = await this.proposeFire({ account: input.node!, tier });
        return { verdict, proposalId: r.proposalId, txHash: r.txHash };
      }
      case "activate":
      case "deactivate": {
        const r = await this.proposeSetActive({
          account: input.node!,
          active: input.action === "activate",
          tier,
        });
        return { verdict, proposalId: r.proposalId, txHash: r.txHash };
      }
      case "reparent": {
        const r = await this.proposeReparent({
          account: input.node!,
          newParent: input.parent!,
          tier,
        });
        return { verdict, proposalId: r.proposalId, txHash: r.txHash };
      }
      case "set-cap": {
        const r = await this.proposeSetAgentCap({
          agent: input.node!,
          cap: input.cap ?? 0n,
          tier,
        });
        return { verdict, proposalId: r.proposalId, txHash: r.txHash };
      }
      case "set-whitelist": {
        const r = await this.proposeSetWhitelist({
          target: input.target!,
          allowed: input.allowed ?? true,
          tier,
        });
        return { verdict, proposalId: r.proposalId, txHash: r.txHash };
      }
      case "set-policy": {
        const r = await this.proposeSetNodePolicy({
          node: input.node!,
          policyModule: input.target!,
          tier,
        });
        return { verdict, proposalId: r.proposalId, txHash: r.txHash };
      }
      default:
        throw new Error(`org action "${input.action}" is not supported yet`);
    }
  }

  /**
   * Move allowances on behalf of a flow. "run-epoch" is a genuine direct write
   * (the orchestrator is the EpochStreamer operator by design); grants and
   * streams are treasury-touching and route through governance on the same
   * verdict-picks-tier rule as `orgAction`.
   */
  async setBudget(
    input: BudgetActionInput & { principal?: `0x${string}`; ceiling?: `0x${string}` },
  ): Promise<{
    verdict: Verdict;
    proposalId?: string;
    epoch?: number;
    txHash?: `0x${string}`;
  }> {
    const agent = input.principal ?? this.workerAgent;
    const { verdict } = await this.checkEffectivePolicy({
      agent,
      ceiling: input.ceiling,
      target: input.node ?? this.spendTarget,
      value: input.amount ?? 0n,
      policyModule: this.authorityPolicyModule(),
    });
    if (verdict === "DENY") return { verdict };

    if (input.action === "run-epoch") {
      const r = await this.runEpoch();
      return { verdict, epoch: r.epoch, txHash: r.txHash };
    }

    const r = await this.proposeSetGrant({
      account: input.node!,
      amount: input.amount ?? 0n,
      tier: verdict === "ALLOW" ? "low" : "high",
    });
    return { verdict, proposalId: r.proposalId, txHash: r.txHash };
  }

  /** Act on the GovernanceModule directly (seat-gated onchain, not by policy). */
  async governanceAction(
    input: GovernanceActionInput,
  ): Promise<{ proposalId?: string; txHash?: `0x${string}` }> {
    switch (input.action) {
      case "vote": {
        const r = await this.voteGovernance(input.proposalId!, input.support ?? true);
        return { proposalId: input.proposalId, txHash: r.txHashes[0] };
      }
      case "veto": {
        const r = await this.vetoGovernance(input.proposalId!);
        return { proposalId: input.proposalId, txHash: r.txHash };
      }
      case "execute": {
        const r = await this.executeGovernance(input.proposalId!);
        return { proposalId: input.proposalId, txHash: r.txHash };
      }
      case "propose": {
        if (!isOnchainClient(this.client)) {
          throw new Error("governance propose requires onchain mode");
        }
        const r = await this.client.proposeGovernance({
          tier: input.tier ?? "low",
          target: input.target!,
          data: (input.data ?? "0x") as `0x${string}`,
        });
        this.pushAudit({
          type: "ProposalCreated",
          at: new Date().toISOString(),
          payload: {
            proposalId: r.proposalId,
            action: "generic",
            target: input.target,
            tier: input.tier ?? "low",
            txHash: r.txHash,
          },
        });
        return { proposalId: r.proposalId, txHash: r.txHash };
      }
      default:
        throw new Error(`unknown governance action "${input.action}"`);
    }
  }

  /** Append an event to the audit ring on behalf of a sibling surface (flows). */
  recordAudit(event: ProtocolEvent): void {
    this.pushAudit(event);
  }

  /** Persisted session records, newest first (restart-surviving history). */
  async sessionHistory(limit = 50): Promise<SessionRecord[]> {
    const rows = await this.runtimeStore.recentSessions(limit);
    // `sealedKey` is stripped here rather than at the route, because this is
    // the only path out of the store and a second caller must not have to
    // remember. Sealed or not, key material has no business in a response.
    return rows.map(({ sealedKey: _sealed, ...row }) => row);
  }

  /** Persisted intent records, newest first (restart-surviving history). */
  async intentHistory(limit = 50): Promise<IntentRecord[]> {
    return this.runtimeStore.recentIntents(limit);
  }

  get runtimeStoreName(): string {
    return this.runtimeStore.name;
  }

  /**
   * Persist session metadata, plus the private key **sealed** when a sealing
   * key is configured (see secretBox.ts). Cleartext keys are never written.
   *
   * Awaited by callers on the onchain path: a crash between `issueSession` and
   * this write would strand a key that cost gas to mint and leave a live
   * onchain session nothing can sign for.
   */
  private recordSession(session: SessionKey, privateKey?: `0x${string}`): Promise<void> {
    return this.runtimeStore.saveSession({
      keyId: session.keyId,
      agent: session.agent,
      keyAddress: session.keyAddress,
      sealedKey: privateKey ? sealSessionKey(privateKey) : null,
      expiresAt: new Date(session.expiresAt).toISOString(),
      scopes: session.scopes,
      maxValue: session.maxValue,
      allowedTarget: session.allowedTarget,
      mode: this.mode,
      chainId: this.chainId ?? undefined,
      status: "active",
      issuedAt: new Date().toISOString(),
    });
  }

  /** Crew defaults for flow gate steps that omit agent/target. */
  get defaultAgent(): `0x${string}` {
    return this.workerAgent;
  }

  get defaultSpendTarget(): `0x${string}` {
    return this.spendTarget;
  }

  private pushAudit(event: ProtocolEvent): void {
    this.localAudit.push(event);
    if (this.localAudit.length > AUDIT_RING_MAX) {
      this.localAudit.splice(0, this.localAudit.length - AUDIT_RING_MAX);
    }
    // Fire-and-forget; the store swallows its own errors.
    void this.auditStore.append(event);
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
