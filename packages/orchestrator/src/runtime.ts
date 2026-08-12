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
  readAccountBalances,
  readTokenMetadata,
  simulateIntentAction,
  type OnchainLacrewClient,
  type ResolveResult,
  type TokenLookup,
} from "@lacrew/sdk";
import type { LacrewClient } from "@lacrew/sdk/testing";
import {
  type DelegationProvider,
  type SessionDelegation,
  ANVIL_CHAIN_ID,
  chainMetadata,
  publicRpcUrl,
  escalationRouterAbi,
  getAddresses,
  hasDeployment,
  listAssetStacks,
  resolveAssetStack,
  sessionRegistryAbi,
  ADDRESS_ENV_VARS,
  MOCK_MANAGER,
  MOCK_WORKER,
  SESSION_SCOPES,
  type AgentWallet,
  type ApprovalAuthority,
  type Allowance,
  type AssetStack,
  type ChainWallets,
  type NodeKind,
  type WatchedChain,
  type GovernanceConfig,
  type GovernanceProposal,
  type GovernanceSeat,
  type GovernanceTier,
  type Intent,
  type ProtocolEvent,
  type SessionKey,
  type SessionScope,
  type TreasuryBalance,
  type EpochGrant,
  type NodePolicyStack,
  narrowScopesForEscalation,
  policyForcesEscalation,
} from "@lacrew/core";
import { createPublicClient, http, parseEther, parseEventLogs, type Hex, type Log } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { Verdict } from "@lacrew/flows";
import type {
  BudgetActionInput,
  GovernanceActionInput,
  OrgActionInput,
} from "@lacrew/adapter-agents-mcp";
import {
  issueSession,
  isSessionExpired,
  revokeSession,
  createEphemeralSession,
} from "./sessions.js";
import { Conversation, type Message, type PostInput, type ThreadScope } from "./conversation.js";
import {
  AgentControls,
  AgentPausedError,
  type AgentBrief,
  type BriefLayer,
} from "./agentControls.js";
import { worstVerdict } from "./flowScope.js";
import { decideAutoExecute } from "./governanceSweep.js";
import { sealSessionKey, unsealSessionKey, sessionSealingAvailable } from "./secretBox.js";
import { planNodeStack, stackUnchanged } from "./policyPlan.js";
import { watchlistFromEnv } from "./walletWatchlist.js";
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

/**
 * How much of a live rate window must remain before its ESCALATE is trusted to
 * narrow a key. A rate limit's verdict resets with the window, so the gap between
 * reading it and the propose being mined is a window in which ESCALATE can become
 * ALLOW — and a key narrowed on the stale answer would revert a call the policy
 * now permits. A minute is far longer than a propose takes to land, and costs
 * only the narrowing on calls made in the last seconds of a window.
 */
const RATE_WINDOW_MARGIN_SEC = 60;

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

/** The shape of a directive, for the audit trail — counts and labels, never text. */
function summarizeBrief(brief: AgentBrief | null): {
  labels: string[];
  resources: number;
  skills: number;
} {
  const layers = brief?.layers ?? [];
  return {
    labels: layers.map((l) => l.label),
    resources: layers.reduce((n, l) => n + (l.resources?.length ?? 0), 0),
    skills: layers.reduce((n, l) => n + (l.skills?.length ?? 0), 0),
  };
}

/**
 * One module in a node's desired stack, as `proposeNodePolicyStack` takes it.
 * Whitelist / spend-cap carry no params — they reuse the org's shared modules,
 * whose values are already per-target / per-agent. Rate and window params are
 * constructor-immutable onchain, so specifying them means deploying a module.
 */
export type NodeStackModuleSpec =
  | { kind: "whitelist" }
  | { kind: "spend_cap" }
  | { kind: "rate_limit"; maxActions: number; windowSeconds: number }
  | { kind: "time_window"; startSecondOfDay: number; endSecondOfDay: number };

const AUDIT_RING_MAX = 200;
/** How long a persisted-audit read is reused; the dashboard polls every 3s. */
const AUDIT_STORE_TTL_MS = 2_000;

export interface CrewRuntimeOptions {
  /**
   * Account-level session delegations (F1.3): when set, boot also issues a
   * budget-caveated delegation seat→session-key and revoke disables it.
   * Absent means none are issued — the protocol path is unaffected.
   */
  delegations?: DelegationProvider;
  /**
   * Required. It used to default to the in-memory test client, which is how a
   * runtime with no chain still answered every read with an invented org.
   * Tests inject a client explicitly; production builds one from env.
   */
  client: LacrewClient | OnchainLacrewClient;
  workerAgent?: `0x${string}`;
  spendTarget?: `0x${string}`;
  managerAgent?: `0x${string}`;
  mode?: RuntimeMode;
  chainId?: number;
  /** Chains/tokens to read agent balances on; empty = the bound chain only. */
  watchlist?: WatchedChain[];
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
  return (
    "publicClient" in client && typeof (client as OnchainLacrewClient).publicClient === "object"
  );
}

/**
 * Why a runtime could not be built. The caller reports the reason rather than
 * substituting an org, so "we cannot reach the chain" never renders as "this
 * workspace has no agents".
 */
export type RuntimeBootFailure =
  | "no_rpc"
  | "no_private_key"
  | "no_deployment"
  | "incomplete_deployment"
  | "rpc_unreachable"
  | "chain_id_mismatch"
  | "delegations_unavailable";

export type RuntimeBoot =
  { ok: true; runtime: CrewRuntime } | { ok: false; reason: RuntimeBootFailure; detail: string };

/**
 * Build a runtime from env.
 *
 * There is no mock fallback. It used to return an in-memory runtime whenever
 * RPC or a key was missing, which is where every fabricated org, intent and
 * session downstream came from — the orchestrator answered confidently with an
 * organisation nobody owned. A missing chain is now a reported failure.
 *
 * The RPC is probed rather than assumed: constructing a viem client never
 * fails, so without a probe a misconfigured endpoint yields a runtime that
 * claims to be onchain and throws on every read.
 */
export async function createRuntimeFromEnv(): Promise<RuntimeBoot> {
  const rpc = process.env.ANVIL_RPC ?? process.env.RPC_URL;
  if (!rpc) {
    return {
      ok: false,
      reason: "no_rpc",
      detail: "Set ANVIL_RPC (or RPC_URL) to a JSON-RPC endpoint.",
    };
  }
  const pk = normalizePk(process.env.PRIVATE_KEY);
  if (!pk) {
    return {
      ok: false,
      reason: "no_private_key",
      detail: "Set PRIVATE_KEY; it signs proposals and sponsors session gas.",
    };
  }

  const chainId = Number(process.env.CHAIN_ID ?? ANVIL_CHAIN_ID);
  if (!hasDeployment(chainId)) {
    return {
      ok: false,
      reason: "no_deployment",
      detail: `No contracts deployed for chain ${chainId}. Run \`lacrew deploy\`, or set the LACREW_* address overrides.`,
    };
  }

  const addresses = getAddresses(chainId);

  // An address book can name the contracts and still omit the seats. A seat
  // filled in from a demo fixture would have the runtime propose as an agent
  // the org never hired: onchain that reverts, and until it does every read
  // describes work nobody authorised. Checked before dialing out — it is a
  // config gap no reachable RPC would fix.
  const { worker, manager, x402Target } = addresses;
  if (!worker || !manager || !x402Target) {
    const missing = (["worker", "manager", "x402Target"] as const).filter((k) => !addresses[k]);
    return {
      ok: false,
      reason: "incomplete_deployment",
      detail: `Chain ${chainId} has contracts but no ${missing.join(", ")}. Run \`lacrew deploy\` to seed the org, or set ${missing
        .map((k) => ADDRESS_ENV_VARS[k])
        .join(", ")}.`,
    };
  }

  const managerPk = normalizePk(process.env.MANAGER_PRIVATE_KEY);
  const account = privateKeyToAccount(pk);
  const resolverAccount = managerPk ? privateKeyToAccount(managerPk) : account;
  // A dedicated issuer key lets the process issue session keys without holding
  // root. It signs `SessionRegistry.issue`/`revoke`; root authorises it once via
  // `setIssuer`. Absent the env, issuance falls back to the main account.
  const issuerPk = normalizePk(process.env.LACREW_ISSUER_PRIVATE_KEY);
  const issuerAccount = issuerPk ? privateKeyToAccount(issuerPk) : account;

  const client = createOnchainClient({
    transport: http(rpc),
    account,
    resolverAccount,
    issuerAccount,
    chainId,
    addresses,
    indexerPath: process.env.INDEXER_PATH,
  });

  // Probe before claiming to be onchain. A wrong chain is worse than an
  // unreachable one: the addresses resolve, the reads succeed, and they
  // describe somebody else's deployment.
  let reported: number;
  try {
    reported = await client.publicClient.getChainId();
  } catch (err) {
    return {
      ok: false,
      reason: "rpc_unreachable",
      detail: `Could not reach ${rpc}: ${err instanceof Error ? err.message.split("\n")[0] : "unknown error"}`,
    };
  }
  if (reported !== chainId) {
    return {
      ok: false,
      reason: "chain_id_mismatch",
      detail: `CHAIN_ID is ${chainId} but ${rpc} reports ${reported}; the address book would be for the wrong chain.`,
    };
  }

  // Authorise a dedicated issuer key when one is configured and not already the
  // registry's issuer. Only root may `setIssuer`, so this succeeds when the main
  // account is root (the local/demo default) and is a harmless no-op otherwise —
  // in a split-key deployment root authorises the issuer out of band, and the
  // orchestrator only needs the key, not the right to grant it.
  if (issuerAccount.address.toLowerCase() !== account.address.toLowerCase()) {
    try {
      const current = await client.getIssuer();
      if (current.toLowerCase() !== issuerAccount.address.toLowerCase()) {
        await client.setIssuer(issuerAccount.address);
      }
    } catch (err) {
      console.warn(
        `[orchestrator] Could not set SessionRegistry issuer to ${issuerAccount.address}: ${
          err instanceof Error ? err.message.split("\n")[0] : "unknown error"
        }. Root must authorise it (setIssuer) for issuance to work.`,
      );
    }
  }

  // Account-level session delegations (F1.3), opt-in per deployment. A
  // misconfiguration is a reported boot failure, not a silently
  // delegation-less runtime the operator believes is issuing them.
  let delegations: DelegationProvider | undefined;
  if (process.env.LACREW_DELEGATIONS) {
    if (process.env.LACREW_DELEGATIONS !== "metamask") {
      return {
        ok: false,
        reason: "delegations_unavailable",
        detail: `Unknown LACREW_DELEGATIONS provider "${process.env.LACREW_DELEGATIONS}" (supported: metamask).`,
      };
    }
    try {
      const { createMetaMaskDelegationProvider } = await import("@lacrew/adapter-wallet-metamask");
      delegations = createMetaMaskDelegationProvider({
        rpcUrl: rpc,
        chainId,
        owner: account,
        ...(addresses.mockUSDC ? { token: addresses.mockUSDC } : {}),
      });
    } catch (err) {
      return {
        ok: false,
        reason: "delegations_unavailable",
        detail: `LACREW_DELEGATIONS=metamask but the provider could not start: ${
          err instanceof Error ? err.message : "unknown error"
        }`,
      };
    }
  }

  return {
    ok: true,
    runtime: new CrewRuntime({
      client,
      mode: "onchain",
      chainId,
      workerAgent: worker,
      spendTarget: x402Target,
      managerAgent: manager,
      auditStore: createAuditStoreFromEnv(),
      runtimeStore: createRuntimeStoreFromEnv(),
      watchlist: watchlistFromEnv(),
      ...(delegations ? { delegations } : {}),
    }),
  };
}

export class CrewRuntime {
  private readonly client: LacrewClient | OnchainLacrewClient;
  private readonly workerAgent: `0x${string}`;
  private readonly spendTarget: `0x${string}`;
  private readonly managerAgent: `0x${string}`;
  readonly mode: RuntimeMode;
  readonly chainId: number | null;
  /** Chains and tokens agent balances are read on, beyond the address book. */
  private watchlist: WatchedChain[];
  /**
   * Sessions keyed by agent *and* the limits they were issued under. A flow runs
   * as its invoking principal, so a single key can't be shared across agents —
   * the chain binds each key to exactly one agent. Keying on limits too matters
   * for scope ceilings: reusing a cached wide key for a tighter-scoped run would
   * silently hand back the authority the ceiling is supposed to remove.
   * Private keys stay in this map and never reach the store or audit payloads.
   */
  private readonly delegations?: DelegationProvider;
  private readonly sessions = new Map<
    string,
    { session: SessionKey; privateKey?: `0x${string}` }
  >();
  /** agent (lowercased) => scopes last explicitly requested for it. */
  private readonly sessionScopePolicy = new Map<string, SessionScope[]>();
  /** Standing per-agent controls: the pause gate and the brief (see agentControls.ts). */
  private readonly agentControls: AgentControls;
  /** The crew's conversation — claims and questions, never authority (F1.7). */
  private readonly conversation: Conversation;
  private readonly messageObservers = new Set<(message: Message) => void>();
  /** Local audit ring for onchain mode (demo works without indexer). */
  private readonly localAudit: ProtocolEvent[] = [];
  /** Distinguishes same-millisecond local events; see pushAudit. */
  private auditSeq = 0;
  private auditCache: { events: ProtocolEvent[]; at: number } | undefined;
  private readonly auditStore: AuditStore;
  private readonly runtimeStore: RuntimeStore;

  /**
   * The durable store behind this runtime, for surfaces that persist beside it
   * (connector write policy and its asks, F2.24) rather than inside it. They
   * share one store so a self-host deployment configures one database, not one
   * per feature.
   */
  get store(): RuntimeStore {
    return this.runtimeStore;
  }

  constructor(options: CrewRuntimeOptions) {
    this.mode = options.mode ?? "mock";
    // The demo fixtures below belong to the in-memory client only. An onchain
    // runtime that adopted them would sign as an address the org does not
    // contain, so the caller must name real seats or not claim to be onchain.
    if (this.mode === "onchain") {
      const missing = (["workerAgent", "managerAgent", "spendTarget"] as const).filter(
        (k) => !options[k],
      );
      if (missing.length > 0) {
        throw new Error(
          `An onchain CrewRuntime needs ${missing.join(", ")}; there is no demo address to stand in for a real seat.`,
        );
      }
    }
    this.client = options.client;
    this.workerAgent = options.workerAgent ?? MOCK_WORKER;
    this.spendTarget = options.spendTarget ?? "0x4444444444444444444444444444444444444444";
    this.managerAgent = options.managerAgent ?? MOCK_MANAGER;
    this.chainId = options.chainId ?? null;
    this.watchlist = options.watchlist ?? [];
    this.auditStore = options.auditStore ?? createMemoryAuditStore();
    this.runtimeStore = options.runtimeStore ?? createMemoryRuntimeStore();
    this.agentControls = new AgentControls(this.runtimeStore);
    this.conversation = new Conversation(this.runtimeStore);
    this.delegations = options.delegations;
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
        window: limits.window,
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
        this.sessionCacheKey(
          session.agent,
          limits.maxValue,
          limits.allowedTarget,
          limits.window,
          limits.rate,
        ),
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
  ): Promise<{
    valid: boolean;
    maxValue: bigint;
    allowedTarget: `0x${string}`;
    window?: { start: number; end: number };
    rate?: { maxProposals: number; ratePeriod: number };
  } | null> {
    if (!isOnchainClient(this.client)) return null;
    const registry = this.client.addresses.sessionRegistry;
    if (!registry) return null;
    const client = this.client;
    try {
      const [valid, maxValue, allowedTarget] = (await client.publicClient.readContract({
        address: registry,
        abi: sessionRegistryAbi,
        functionName: "keyLimits",
        args: [agent, key],
      })) as [boolean, bigint, `0x${string}`, bigint];
      if (!valid) return { valid, maxValue, allowedTarget };
      // Window and rate are separate from keyLimits, but the cache key needs them:
      // a reclaimed windowed/rate-limited key keyed without them could be reused
      // for a looser request. Read them for the active session behind this key.
      const id = (await client.publicClient.readContract({
        address: registry,
        abi: sessionRegistryAbi,
        functionName: "activeKeySession",
        args: [agent, key],
      })) as bigint;
      const session = (await client.publicClient.readContract({
        address: registry,
        abi: sessionRegistryAbi,
        functionName: "sessions",
        args: [id],
      })) as readonly unknown[];
      const rl = (await client.publicClient.readContract({
        address: registry,
        abi: sessionRegistryAbi,
        functionName: "rateLimits",
        args: [id],
      })) as readonly unknown[];
      const windowStart = Number(session[8]);
      const windowEnd = Number(session[9]);
      const maxProposals = Number(rl[0]);
      const ratePeriod = Number(rl[1]);
      return {
        valid,
        maxValue,
        allowedTarget,
        window: windowEnd === 0 ? undefined : { start: windowStart, end: windowEnd },
        rate: maxProposals === 0 ? undefined : { maxProposals, ratePeriod },
      };
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
      /**
       * Full pinned target set, when the caller has one. Only rotation does:
       * re-issuing a multi-target key from `allowedTarget` alone would drop
       * every target but the first.
       */
      allowedTargets?: `0x${string}`[];
      /** What the key may do. Defaults to the full vocabulary. */
      scopes?: SessionScope[];
      /**
       * Whether explicit `scopes` update the agent's standing policy. True for an
       * operator's deliberate narrowing (it must stick, or internal boots
       * re-widen it); false for a per-run narrowing like a flow's scope, which
       * applies to this key only and must not re-scope the agent.
       */
      persistScopePolicy?: boolean;
      /** Daily UTC window `[start, end)` in seconds; the chain refuses proposes outside it. */
      window?: { start: number; end: number };
      /** Propose rate limit; the chain refuses more than `maxProposals` per `ratePeriod`. */
      rate?: { maxProposals: number; ratePeriod: number };
    },
  ): Promise<SessionKey> {
    const forAgent = agent ?? this.workerAgent;
    // Ahead of the cache lookup on purpose: a paused agent must not be handed
    // back a key it was issued before the pause, which is exactly the key the
    // operator meant to take away.
    const paused = this.agentControls.pausedDetail(forAgent);
    if (paused) throw new AgentPausedError(forAgent, paused.at, paused.reason);
    const ceiling = limits?.maxValue;
    // An explicit narrowing sticks until it is explicitly changed. Internal
    // callers (propose, purchase) boot without scopes, so defaulting to the
    // full set here would silently re-widen an agent on the next action and
    // make narrowing unobservable outside the one call that asked for it.
    const scopes = limits?.scopes ?? this.scopePolicyFor(forAgent);
    if (limits?.scopes && limits.persistScopePolicy !== false) {
      this.sessionScopePolicy.set(forAgent.toLowerCase(), limits.scopes);
    }
    const key = this.sessionCacheKey(
      forAgent,
      ceiling,
      limits?.allowedTarget,
      limits?.window,
      limits?.rate,
    );
    const held = this.sessions.get(key);
    // A cached session is only reusable when its scopes match what was asked
    // for. Reusing a wider one would hand back authority this call did not
    // request, which is the failure the scopes exist to prevent.
    //
    // A revoked one is never reusable either. `revokeSessionById` leaves the
    // revoked record in this cache so history reads still find it, and without
    // this check the very next boot handed the dead key straight back — the
    // chain would refuse whatever it signed, and the revocation an operator
    // performed would appear to have done nothing.
    if (
      held &&
      !held.session.revoked &&
      !isSessionExpired(held.session) &&
      sameScopes(held.session.scopes, scopes)
    ) {
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
        ...(limits?.allowedTargets && limits.allowedTargets.length > 0
          ? { allowedTargets: limits.allowedTargets }
          : {}),
        window: limits?.window,
        rate: limits?.rate,
      });
      // Root sponsors gas so the session key can submit propose (Phase 0; AA/paymaster later).
      const fundTxHash = await this.fundSessionKey(ephemeral.keyAddress!);
      const delegation = await this.issueSessionDelegation(
        ephemeral.agent,
        ephemeral.keyAddress!,
        maxValue,
        ephemeral.expiresAtSec,
      );
      const session: SessionKey = {
        agent: ephemeral.agent,
        keyId: sessionId,
        keyAddress: ephemeral.keyAddress,
        expiresAt: ephemeral.expiresAt,
        scopes: ephemeral.scopes,
        maxValue: maxValue.toString(),
        allowedTarget,
        ...(limits?.allowedTargets && limits.allowedTargets.length > 0
          ? { allowedTargets: limits.allowedTargets }
          : {}),
        window: limits?.window,
        rate: limits?.rate,
        revoked: false,
        ...(delegation ? { delegation } : {}),
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

    // A chain-backed runtime whose address book has no SessionRegistry cannot
    // issue anything. Handing back an opaque id would look like a live key to
    // every caller, and to the audit trail, while nothing onchain constrains
    // what it signs — the one property a session key exists to provide.
    if (isOnchainClient(this.client)) {
      throw new Error(
        `Cannot issue a session on chain ${this.chainId ?? "unknown"}: no sessionRegistry in the address book. Deploy one, or set ${ADDRESS_ENV_VARS.sessionRegistry}.`,
      );
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

  /**
   * The narrowest scopes that can still carry a spend of `value` by `agent`.
   *
   * A propose whose verdict is provably ESCALATE never reaches
   * `EscalationRouter._requireSpendScope`, so settlement authority on that key
   * is authority the call cannot use. Reading the agent's bound stack turns that
   * into a fact rather than a guess: one escalating member decides the verdict,
   * because any ESCALATE dominates in `PolicyStack.check`. Either an over-cap
   * `SpendCapPolicy` or a `RateLimitPolicy` whose allowance is spent will do it.
   *
   * Every uncertainty keeps the standing scopes — off-chain client, unreadable
   * stack, nothing in it that escalates, a value inside the cap, or a rate window
   * about to lapse. A key too narrow to settle a call the org would have allowed
   * is an outage, so the one-sided failure direction is deliberate.
   */
  async scopesForSpend(agent: `0x${string}`, value: bigint): Promise<SessionScope[]> {
    const standing = this.scopePolicyFor(agent);
    // Nothing to drop: skip the chain reads entirely.
    if (!standing.includes("spend:whitelist")) return standing;
    if (!isOnchainClient(this.client)) return standing;

    let stacks: NodePolicyStack[];
    try {
      stacks = await this.client.getNodePolicies({ nodes: [agent] });
    } catch {
      return standing;
    }

    const stack = stacks[0];
    if (!stack) return standing;
    const forced = policyForcesEscalation(stack.modules, {
      value,
      nowSec: Math.floor(Date.now() / 1000),
      rateWindowMarginSec: RATE_WINDOW_MARGIN_SEC,
    });
    return narrowScopesForEscalation(standing, forced);
  }

  /** Distinct limit sets need distinct keys; see the `sessions` map comment. */
  private sessionCacheKey(
    agent: `0x${string}`,
    maxValue?: bigint,
    allowedTarget?: `0x${string}`,
    window?: { start: number; end: number },
    rate?: { maxProposals: number; ratePeriod: number },
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
    // Window and rate are part of the key too: a session narrowed to business
    // hours or a proposal cap must never be handed back to a boot that asked for
    // neither — that would reuse a tighter key as if it were looser.
    const w = window ? `${window.start}-${window.end}` : "any";
    const r = rate ? `${rate.maxProposals}/${rate.ratePeriod}` : "none";
    return `${agent.toLowerCase()}:${ceiling.toString()}:${target}:${w}:${r}`;
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
    return Boolean(isOnchainClient(this.client) && this.client.addresses.sessionRegistry);
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
    const sessions = await this.client.getSessions();
    // Chain reads carry no account-level delegations — SessionRegistry knows
    // nothing of them. Overlay the runtime's own issue records, minus the
    // signed blob: a reader needs budget and state, and revocation (which
    // does need the signature) runs off the held record, not this surface.
    const held = new Map<string, SessionDelegation>();
    for (const entry of this.sessions.values()) {
      const d = entry.session.delegation;
      if (d) held.set(entry.session.keyId, d);
    }
    if (held.size === 0) return sessions;
    return sessions.map((s) => {
      const d = held.get(s.keyId);
      if (!d) return s;
      const { signed: _signed, ...summary } = d;
      return { ...s, delegation: summary };
    });
  }

  /**
   * Issue the account-level delegation riding a fresh session (F1.3). A
   * failure never fails the boot — the SessionRegistry path is the
   * enforcement users rely on — but it is audited as its own event, because
   * "no delegation" and "delegation issued" are different states the record
   * must keep apart.
   */
  private async issueSessionDelegation(
    agent: `0x${string}`,
    sessionKey: `0x${string}`,
    maxValue: bigint,
    expiresAtSec: number,
  ): Promise<SessionDelegation | undefined> {
    if (!this.delegations) return undefined;
    try {
      const issued = await this.delegations.issue({ agent, sessionKey, maxValue, expiresAtSec });
      let delegation = issued.delegation;
      if (issued.seatDeployTx && isOnchainClient(this.client)) {
        // Root-funded seat deploy (the Phase-0 sponsorship pattern): a
        // delegation only redeems against code. sendBuiltTx throws on
        // revert, so seatDeployed flips only when the deploy actually landed.
        await this.client.sendBuiltTx(issued.seatDeployTx);
        delegation = { ...delegation, seatDeployed: true };
      }
      this.pushAudit({
        type: "SessionDelegationIssued",
        at: new Date().toISOString(),
        payload: {
          agent,
          sessionKey,
          provider: delegation.provider,
          seat: delegation.seat,
          seatDeployed: delegation.seatDeployed,
          budget: delegation.budget,
          expiresAtSec: delegation.expiresAtSec,
        },
      });
      return delegation;
    } catch (err) {
      this.pushAudit({
        type: "SessionDelegationFailed",
        at: new Date().toISOString(),
        payload: {
          agent,
          sessionKey,
          reason: err instanceof Error ? err.message : "delegation_failed",
        },
      });
      return undefined;
    }
  }

  /**
   * Disable a revoked session's delegation onchain. The protocol revoke has
   * already landed; this closes the account-level path too. `disabled` flips
   * only on a landed receipt — a failure is audited, never assumed away, and
   * the delegation still dies at its timestamp caveat when the session
   * expires.
   */
  private async disableSessionDelegation(
    sessionId: string,
    delegation: SessionDelegation | undefined,
  ): Promise<void> {
    if (!delegation || delegation.disabled || !this.delegations) return;
    if (!isOnchainClient(this.client)) return;
    try {
      const beneficiary =
        this.client.walletClient?.account?.address ??
        ("0x0000000000000000000000000000000000000000" as `0x${string}`);
      const tx = await this.delegations.buildRevokeTx(delegation, beneficiary);
      const { txHash } = await this.client.sendBuiltTx(tx);
      delegation.disabled = true;
      this.pushAudit({
        type: "SessionDelegationDisabled",
        at: new Date().toISOString(),
        payload: { keyId: sessionId, seat: delegation.seat, txHash },
      });
    } catch (err) {
      this.pushAudit({
        type: "SessionDelegationDisableFailed",
        at: new Date().toISOString(),
        payload: {
          keyId: sessionId,
          seat: delegation.seat,
          expiresAtSec: delegation.expiresAtSec,
          reason: err instanceof Error ? err.message : "disable_failed",
        },
      });
    }
  }

  /**
   * Retire a session key.
   *
   * `authorizedBy` is recorded rather than assumed: a revoke proved by the
   * workspace root and one an automated containment sweep performed are both
   * legitimate, but they are not the same claim, and an audit trail that called
   * them both "revoked" would let the second read as the first.
   */
  async revokeSessionById(
    sessionId: string,
    authorizedBy?: string,
  ): Promise<{ txHash?: `0x${string}` }> {
    if (!isOnchainClient(this.client)) {
      const held = this.findSessionEntry(sessionId);
      if (held) {
        this.sessions.set(held[0], { session: revokeSession(held[1].session) });
      }
      void this.runtimeStore.markSessionRevoked(sessionId, new Date().toISOString());
      this.pushAudit({
        type: "SessionRevoked",
        at: new Date().toISOString(),
        payload: { keyId: sessionId, mocked: true, ...(authorizedBy ? { authorizedBy } : {}) },
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
      payload: { keyId: sessionId, txHash, ...(authorizedBy ? { authorizedBy } : {}) },
    });
    await this.disableSessionDelegation(sessionId, held?.[1].session.delegation);
    return { txHash };
  }

  /**
   * Retire a key and re-issue one in its place under the retired key's own
   * bounds.
   *
   * Every bound comes from the prior session as the chain records it, never
   * from the caller: a rotation that took its scopes from the request would be
   * an issue endpoint wearing a rotation's name, and the one thing a rotation
   * must not be able to do is hand back more authority than it took away.
   * `boot` treats `maxValue` as a ceiling, so even the deployment's own default
   * can only narrow the replacement further.
   */
  async rotateSessionById(
    sessionId: string,
    authorizedBy?: string,
  ): Promise<{
    revoked: { sessionId: string; txHash?: `0x${string}` };
    session: SessionKey;
    /** False when the prior key could not be read — the caller must not assume its scope carried. */
    preserved: boolean;
  }> {
    const prior =
      (await this.listSessions()).find((s) => s.keyId === sessionId) ??
      this.findSessionEntry(sessionId)?.[1].session;
    const revoked = await this.revokeSessionById(sessionId, authorizedBy);
    const session = await this.boot(prior?.agent, {
      ...(prior?.maxValue ? { maxValue: BigInt(prior.maxValue) } : {}),
      ...(prior?.allowedTarget ? { allowedTarget: prior.allowedTarget } : {}),
      ...(prior?.allowedTargets && prior.allowedTargets.length > 0
        ? { allowedTargets: prior.allowedTargets }
        : {}),
      ...(prior?.scopes ? { scopes: prior.scopes } : {}),
      // A rotation replaces one key; it is not the operator restating what this
      // agent may do from now on, so the standing scope policy is left alone.
      persistScopePolicy: false,
      ...(prior?.window ? { window: prior.window } : {}),
      ...(prior?.rate ? { rate: prior.rate } : {}),
    });
    this.pushAudit({
      type: "SessionRotated",
      at: new Date().toISOString(),
      payload: {
        from: sessionId,
        to: session.keyId,
        agent: session.agent,
        preserved: Boolean(prior),
        ...(authorizedBy ? { authorizedBy } : {}),
      },
    });
    return { revoked: { sessionId, ...revoked }, session, preserved: Boolean(prior) };
  }

  /** The chain's `SessionRegistry.humanRoot`, or null when unreadable. */
  async humanRootAddress(): Promise<`0x${string}` | null> {
    if (!isOnchainClient(this.client)) return null;
    const addr = this.client.addresses.humanRoot;
    return addr && addr !== "0x0000000000000000000000000000000000000000" ? addr : null;
  }

  /* ——— standing agent controls (PRD F1.7) ——— */

  /**
   * Restore pauses and directives left by whoever ran this org before the
   * restart. Call once at boot, before anything can act.
   *
   * A failed load is reported rather than swallowed, and the caller must
   * decide: booting with an empty set silently un-pauses every paused agent
   * and strips every directive, so an agent goes back to work with no
   * guidelines, no resources and no skills — and does the wrong thing
   * competently. That is the failure this store exists to prevent, so it must
   * not be indistinguishable from a clean first boot.
   */
  async hydrateAgentControls(): Promise<{ ok: boolean; loaded: number }> {
    return this.agentControls.hydrate(this.runtimeStore);
  }

  /** The agent this runtime acts as by default — the author of an unattributed post. */
  get workerAddress(): `0x${string}` {
    return this.workerAgent;
  }

  /** True once stored controls were read; false means nothing standing is known. */
  get agentControlsHydrated(): boolean {
    return this.agentControls.hydrated;
  }

  /* ——— conversation (PRD F1.7) ——— */

  /**
   * Restore the crew's conversation.
   *
   * A crew whose history vanished would lose the answers to its own questions,
   * and an agent would re-ask what it had already been told.
   */
  async hydrateConversation(): Promise<{ ok: boolean; loaded: number }> {
    return this.conversation.hydrate(this.runtimeStore);
  }

  /**
   * Post to a thread.
   *
   * Audited, because a claim an agent makes about its own work is exactly the
   * kind of thing that should be attributable later — but as `MessagePosted`,
   * never as the action it describes. A message asserting a spend is not a
   * spend, and the trail must not let the two blur.
   */
  postMessage(input: PostInput): Message {
    const message = this.conversation.post(input);
    this.pushAudit({
      type: "MessagePosted",
      at: message.at,
      payload: {
        messageId: message.id,
        threadId: message.threadId,
        author: message.author,
        authorKind: message.authorKind,
        kind: message.kind,
        // The body stays out: the trail is a bounded ring, and the message
        // itself is served in full from the conversation endpoints.
        refs: message.refs?.length ?? 0,
      },
    });
    for (const observer of this.messageObservers) {
      try {
        observer(message);
      } catch {
        // An observer that throws must not fail the post. A message is a claim
        // and it has already been made; refusing it here would lose the claim
        // to a bug in something that only watches.
      }
    }
    return message;
  }

  /**
   * Watch messages as they land.
   *
   * Used by ask-mode connector writes (F2.24) to notice the answer that
   * releases a suspended run. Deliberately an observer rather than a branch in
   * `postMessage`: this module must not learn to read a message as a decision,
   * because the moment it does, a message is authority.
   */
  onMessage(observer: (message: Message) => void): () => void {
    this.messageObservers.add(observer);
    return () => this.messageObservers.delete(observer);
  }

  thread(scope: ThreadScope, limit = 100): Message[] {
    return this.conversation.thread(scope, limit);
  }

  recentMessages(limit = 100): Message[] {
    return this.conversation.recent(limit);
  }

  listThreads(): Array<{ threadId: string; messages: number; lastAt: string }> {
    return this.conversation.threads();
  }

  openQuestions(scope: ThreadScope): Message[] {
    return this.conversation.openQuestionsIn(scope);
  }

  /** Every unanswered question in the org, oldest first — the human's queue. */
  allOpenQuestions(): Message[] {
    return this.conversation.allOpenQuestions();
  }

  /**
   * Stop this agent acting through this orchestrator.
   *
   * Two things happen, and only the first is durable: new session keys are
   * refused, and every live key for the agent is revoked. Revocation is what
   * makes the pause bite immediately — gating issuance alone would leave a key
   * minted a minute ago working until it expired.
   *
   * Revocation failures are collected, not thrown. A pause that aborts halfway
   * through a roster leaves some keys live while reporting failure, and an
   * operator reaching for this during an incident needs the gate to hold and
   * the partial result named, not an exception and an unknown state.
   */
  async pauseAgent(
    agent: `0x${string}`,
    reason?: string,
  ): Promise<{
    agent: string;
    paused: boolean;
    revoked: string[];
    failed: Array<{ keyId: string; error: string }>;
  }> {
    const at = new Date().toISOString();
    const changed = this.agentControls.pause(agent, at, reason);

    const live = (await this.listSessions()).filter(
      (s) => s.agent.toLowerCase() === agent.toLowerCase() && !s.revoked && !isSessionExpired(s),
    );
    const revoked: string[] = [];
    const failed: Array<{ keyId: string; error: string }> = [];
    for (const session of live) {
      try {
        await this.revokeSessionById(session.keyId);
        revoked.push(session.keyId);
      } catch (err) {
        failed.push({
          keyId: session.keyId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Revoking by id goes through whatever `listSessions` reports, which is not
    // always this process's own cache — so the held keys are dropped directly
    // too. Without this a cached key survives its own revocation, and the pause
    // would gate the next boot while the private key it already holds keeps
    // signing.
    this.purgeHeldSessionsFor(agent);

    if (changed) {
      this.pushAudit({
        type: "AgentPaused",
        at,
        payload: { agent, reason, revoked: revoked.length, failed: failed.length },
      });
    }
    return { agent, paused: true, revoked, failed };
  }

  /**
   * Let this agent hold keys again.
   *
   * Nothing is re-issued: the keys revoked by the pause are gone for good, and
   * the next action boots a fresh one. Handing back the old key would undo the
   * revocation the pause performed.
   */
  resumeAgent(agent: `0x${string}`): { agent: string; paused: boolean; changed: boolean } {
    const changed = this.agentControls.resume(agent);
    if (changed) {
      this.pushAudit({
        type: "AgentResumed",
        at: new Date().toISOString(),
        payload: { agent },
      });
    }
    return { agent, paused: false, changed };
  }

  /**
   * Mark every cached session for this agent revoked and drop its private key.
   *
   * The record stays so history reads still find it; only the ability to sign
   * goes away. Dropping the entry entirely would let the next boot mint a key
   * under the same cache slot and lose the fact that one was ever revoked.
   */
  private purgeHeldSessionsFor(agent: string): void {
    const wanted = agent.toLowerCase();
    for (const [key, held] of this.sessions.entries()) {
      if (held.session.agent.toLowerCase() !== wanted) continue;
      this.sessions.set(key, { session: revokeSession(held.session) });
    }
  }

  isAgentPaused(agent: `0x${string}`): boolean {
    return this.agentControls.isPaused(agent);
  }

  listPausedAgents(): Array<{ agent: string; at: string; reason?: string }> {
    return this.agentControls.listPaused();
  }

  /** Replace an agent's standing brief. Empty layers clear it. */
  setAgentBrief(agent: `0x${string}`, layers: readonly BriefLayer[]): AgentBrief | null {
    const at = new Date().toISOString();
    const before = this.agentControls.briefFor(agent);
    const brief = this.agentControls.setBrief(agent, layers, at);

    // Recorded after the write, so a rejected directive (over the ceiling)
    // throws without leaving an event claiming it landed.
    const summary = summarizeBrief(brief);
    this.pushAudit({
      type: "AgentDirectiveChanged",
      at,
      payload: {
        agent,
        cleared: brief === null,
        // The shape, never the instruction text: the trail is a bounded ring
        // and a directive runs to thousands of characters. /agents/controls
        // serves the text in full.
        layers: summary.labels,
        resources: summary.resources,
        skills: summary.skills,
        previousLayers: summarizeBrief(before).labels,
      },
    });
    return brief;
  }

  agentBrief(agent: `0x${string}`): AgentBrief | null {
    return this.agentControls.briefFor(agent);
  }

  listAgentBriefs(): AgentBrief[] {
    return this.agentControls.listBriefs();
  }

  /** The system prompt an agent's turn runs under, brief applied. */
  systemPromptFor(agent: string): string {
    return this.agentControls.systemPromptFor(agent);
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
    /** Flow scope's daily window, carried onto the run's session key. */
    window?: { start: number; end: number };
    /** Flow scope's propose rate limit, carried onto the run's session key. */
    rate?: { maxProposals: number; ratePeriod: number };
    /** Flow scope's session scope mask, carried onto the run's key (per-run only). */
    scopes?: SessionScope[];
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
    // A flow's explicit scopes win; otherwise ask for the least this spend can
    // be carried out with, which is propose-only whenever the chain will
    // certainly escalate it.
    const scopes = input.scopes ?? (await this.scopesForSpend(agent, value));
    const session = await this.boot(agent, {
      maxValue: ceilingValue,
      window: input.window,
      rate: input.rate,
      scopes,
      // A flow's scope narrows this run's key, not the agent's standing policy.
      persistScopePolicy: false,
    });
    if (isSessionExpired(session)) {
      this.sessions.set(
        this.sessionCacheKey(agent, ceilingValue, undefined, input.window, input.rate),
        { session: revokeSession(session) },
      );
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

  /**
   * Who the chain is waiting on for one pending intent, and whether that is the
   * workspace's human root (PRD F2.6).
   *
   * Read without simulating. `listPending` dry-runs every approval, traces it
   * and measures its state diffs — worth it for an approver reading a queue,
   * and several chain round-trips to answer a question that is only "whose
   * signature does this need".
   *
   * An intent nobody is waiting on is reported as such rather than as
   * manager-depth: this answer decides whether a root proof is demanded, and
   * "we could not find it" defaulting to "no proof needed" is the failure the
   * gate exists to prevent.
   */
  async approvalAuthority(intentId: string): Promise<ApprovalAuthority> {
    const intents = await this.client.getPendingIntents();
    const intent = intents.find((i) => i.id === intentId);
    if (!intent) return { found: false, awaitingApprover: null, isRoot: false };
    const awaiting = intent.awaitingApprover;
    if (!awaiting) return { found: true, awaitingApprover: null, isRoot: false };
    return {
      found: true,
      awaitingApprover: awaiting,
      isRoot: await this.isHumanRoot(awaiting),
    };
  }

  /** The router the org escalates through, when this runtime is on a chain. */
  escalationRouterAddress(): `0x${string}` | null {
    return isOnchainClient(this.client) ? this.client.addresses.escalationRouter : null;
  }

  /** One pending intent, or null once the chain no longer awaits anyone on it. */
  async pendingIntent(intentId: string): Promise<Intent | null> {
    const intents = await this.client.getPendingIntents();
    return intents.find((i) => i.id === intentId) ?? null;
  }

  /**
   * Settle an intent whose approver is a contract this process holds no key for
   * — a passkey-owned Safe sending `resolve` through its own `execTransaction`
   * (PRD F2.6 / F1.3).
   *
   * `send` broadcasts and returns the hash; everything else — what the chain
   * says afterwards, the store, the audit entry, the receipt ingestion — runs
   * exactly as it does for a key this process does hold. The chain is re-read
   * rather than assumed: a transaction that was sent is not by itself a spend
   * that was authorised, and an intent still pending afterwards must not be
   * recorded as resolved.
   */
  async resolveThroughSafe(
    intentId: string,
    approved: boolean,
    safeAddress: `0x${string}`,
    authorizedBy: string,
    send: () => Promise<`0x${string}`>,
  ): Promise<ResolveResult> {
    const before = await this.pendingIntent(intentId);
    if (!before) throw new Error("intent_not_pending");
    return this.resolve(intentId, approved, safeAddress, authorizedBy, async () => {
      const txHash = await send();
      const after = await this.pendingIntent(intentId);
      return {
        intent: after ?? {
          ...before,
          resolved: true,
          approved,
          verdict: approved ? "ALLOW" : "DENY",
        },
        escalated: Boolean(after),
        txHash,
      };
    });
  }

  /**
   * Record a Safe-root approval whose transaction someone else broadcast.
   *
   * The chain decides, not the caller: an intent still awaiting its approver
   * comes back unconfirmed and nothing is written. A browser reporting that it
   * sent something is not a spend that happened, and a queue cleared on that
   * report is an approver told money moved when it may not have.
   */
  async confirmSafeResolve(input: {
    intentId: string;
    approved: boolean;
    approver: `0x${string}`;
    txHash?: `0x${string}`;
  }): Promise<{
    confirmed: boolean;
    awaitingApprover?: `0x${string}` | null;
    txHash?: `0x${string}`;
  }> {
    const stillPending = await this.pendingIntent(input.intentId);
    if (stillPending) {
      return { confirmed: false, awaitingApprover: stillPending.awaitingApprover };
    }
    void this.runtimeStore.markIntentResolved(input.intentId, {
      status: input.approved ? "approved" : "denied",
      resolveTxHash: input.txHash,
      resolvedAt: new Date().toISOString(),
    });
    this.pushAudit({
      type: "IntentResolved",
      at: new Date().toISOString(),
      payload: {
        intentId: input.intentId,
        approved: input.approved,
        escalated: false,
        approver: input.approver,
        authorizedBy: "root:safe-passkey",
        txHash: input.txHash,
      },
    });
    if (input.txHash) await this.ingestReceiptLogs(input.txHash);
    return { confirmed: true, ...(input.txHash ? { txHash: input.txHash } : {}) };
  }

  /**
   * Whether an address holds the org's human-root seat.
   *
   * The org chart answers first, because the root is a seat in the tree; the
   * address book's `humanRoot` is a deployment convenience that a chain
   * without one leaves empty. Both are consulted, and a chart this process
   * cannot read raises rather than answering "no" — a false negative here
   * silently drops the proof requirement on the one intent that most needs it.
   */
  private async isHumanRoot(address: `0x${string}`): Promise<boolean> {
    const wanted = address.toLowerCase();
    const booked = isOnchainClient(this.client) ? this.client.addresses.humanRoot : undefined;
    if (booked && booked.toLowerCase() === wanted) return true;
    const nodes = await this.client.getOrgTree();
    return nodes.some((n) => n.kind === "human_root" && n.account.toLowerCase() === wanted);
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
          const approval = await onchain.simulateResolveApproval(intent.id).catch(() => null);
          if (approval && !approval.ok) {
            simulation.status = "revert";
            simulation.warnings.push(`Approval dry-run reverted: ${approval.reason ?? "unknown"}`);
          } else if (approval?.ok) {
            simulation.warnings.push("Approval dry-run succeeded (eth_call).");
            // Measured movements from executing the approval in a simulated
            // block — what the chain would actually do, including anything
            // the target's own code moves. Null (node can't simulate) simply
            // leaves the heuristic standing alone, honestly unmeasured.
            const measured = await onchain.simulateApprovalStateDiffs(intent.id).catch(() => null);
            if (measured) simulation.measuredChanges = measured;
            // Which contracts the approval would actually execute, in order —
            // the last piece an approver needs beside verdict and movements.
            const trace = await onchain.traceApprovalCalls(intent.id).catch(() => null);
            if (trace) simulation.callTrace = trace;
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
  /**
   * Operation counts since `since` (default: start of the current UTC month) —
   * the read a billing meter is built from, served as raw event-type counts so
   * billing semantics stay out of the public package. Counted from the full
   * persisted trail when a database is wired (`complete: true`); otherwise
   * from the bounded in-memory ring, flagged incomplete so nobody bills
   * against a window that silently forgot its oldest events.
   */
  async usage(since?: string): Promise<{
    since: string;
    counts: Record<string, number>;
    complete: boolean;
    store: string;
  }> {
    const now = new Date();
    const sinceIso =
      since ?? new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
    const persisted = await this.auditStore.countByTypeSince(sinceIso);
    if (persisted) {
      return { since: sinceIso, counts: persisted, complete: true, store: this.auditStore.name };
    }
    // The ring, not the merged audit() view: that merge also carries the
    // client's own copy of each event (different timestamps defeat its dedupe
    // key), and a meter that counts one intent twice overbills it.
    const cutoff = Date.parse(sinceIso);
    const counts: Record<string, number> = {};
    for (const event of this.localAudit) {
      if (Date.parse(event.at) >= cutoff) {
        counts[event.type] = (counts[event.type] ?? 0) + 1;
      }
    }
    return { since: sinceIso, counts, complete: false, store: "memory" };
  }

  /**
   * The trail over one window — what a period report (F2.33) is folded from.
   *
   * Read from the persisted store when one is wired, because the indexer writes
   * chain events into the same table from another process and a report that
   * missed them would understate what a desk spent. Without a store, the
   * bounded local ring answers and the window is flagged incomplete: a P&L that
   * silently forgot its oldest rows is a lower bill than the operator will get.
   */
  async auditBetween(
    fromIso: string,
    toIso: string,
    limit = 5_000,
  ): Promise<{ events: ProtocolEvent[]; complete: boolean; store: string }> {
    const persisted = await this.auditStore.between(fromIso, toIso, limit);
    if (persisted) {
      return { ...persisted, store: this.auditStore.name };
    }
    const from = Date.parse(fromIso);
    const to = Date.parse(toIso);
    // The ring, not the merged `audit()` view: that merge also carries the
    // client's own copy of each event, and a cost report that counts one spend
    // twice is worse than one that admits it is partial.
    const events = this.localAudit.filter((e) => {
      const t = Date.parse(e.at);
      return Number.isFinite(t) && t >= from && t < to;
    });
    return { events: events.slice(-limit).reverse(), complete: false, store: "memory" };
  }

  /**
   * Allowance balances and per-call caps for the org, in one asset's stack.
   * [] in mock mode — an invented allowance is a claim about money.
   */
  async getAllowances(asset?: string): Promise<Allowance[]> {
    if (!isOnchainClient(this.client)) return [];
    return this.client.getAllowances(undefined, asset);
  }

  async audit(): Promise<ProtocolEvent[]> {
    const [remote, persisted] = await Promise.all([
      this.client.getAuditTrail(),
      this.recentPersistedAudit(),
    ]);
    const seen = new Set<string>();
    const out: ProtocolEvent[] = [];
    // `seq` is present only on events this process raised, and travels with
    // them into the store — so a persisted copy still matches its original.
    const keyOf = (e: ProtocolEvent) =>
      `${e.type}:${e.payload.intentId ?? ""}:${e.payload.txHash ?? ""}:${e.payload.value ?? ""}:${e.payload.seq ?? ""}:${e.at}`;

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
   *
   * `approver` is the seat the chain is waiting on, and onchain it selects the
   * key that signs: `EscalationRouter.resolve` reverts for any other sender, so
   * a resolve that always signed with the manager key would be a manager
   * approving on the root's behalf wherever it happened not to revert.
   *
   * `authorizedBy` records what let this call through — a verified root proof,
   * or the fact that nothing was asked. The trail must never read as though a
   * root signed for a decision no root was shown.
   *
   * `submit` replaces the keyring write for approvers this process holds no key
   * for and never should — a passkey-owned Safe sends `resolve` through its own
   * `execTransaction`. The bookkeeping below is identical either way on
   * purpose: a Safe-settled approval must land in the same store, the same
   * audit entry and the same receipt ingestion as any other, or the trail would
   * quietly describe two different products.
   */
  async resolve(
    intentId: string,
    approved: boolean,
    approver: `0x${string}` = this.managerAgent,
    authorizedBy?: string,
    submit?: () => Promise<ResolveResult>,
  ): Promise<ResolveResult> {
    const result = submit
      ? await submit()
      : await this.client.resolveIntent(intentId, approved, approver);
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
        approver,
        ...(authorizedBy ? { authorizedBy } : {}),
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
   * Per-buyer receipt reads in one call, so a consumer asking "does any of
   * these accounts hold an entitlement?" (e.g. every agent in an org) does not
   * need a round trip per address. A chainless runtime reports every buyer
   * unentitled — it can read no receipts, and inventing one would deliver a
   * paid product for free.
   */
  async marketplaceEntitlements(
    catalogId: string,
    buyers: `0x${string}`[],
  ): Promise<{ entitlements: Record<string, boolean>; purchased: boolean }> {
    const entitlements: Record<string, boolean> = {};
    for (const buyer of buyers) {
      entitlements[buyer] = (await this.marketplaceEntitlement(catalogId, buyer)).purchased;
    }
    return { entitlements, purchased: Object.values(entitlements).some(Boolean) };
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
    // A listing priced over the agent's cap can only escalate, so that key does
    // not need settlement authority either; `persistScopePolicy: false` keeps the
    // narrowing on this purchase rather than re-scoping the agent.
    await this.boot(input.agent, {
      maxValue: quote.gross,
      allowedTarget: market,
      scopes: await this.scopesForSpend(input.agent, quote.gross),
      persistScopePolicy: false,
    });
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

  /**
   * Withdraw everything accrued to this runtime's own signing account. The
   * contract pays `msg.sender`, so the payout can only land on the wallet
   * that registered this deployment's listings — a caller cannot point it at
   * someone else's balance. The owed amount is read first: a zero balance is
   * refused here as `nothing_owed` rather than surfacing as a raw revert.
   */
  async marketplaceWithdraw(): Promise<{
    txHash: string;
    seller: `0x${string}`;
    withdrawn: string;
  }> {
    if (!isOnchainClient(this.client)) throw new Error("marketplace_requires_chain");
    const seller = this.client.walletClient?.account?.address;
    if (!seller) throw new Error("marketplace_requires_chain");
    const owed = await this.client.marketplaceEarnings(seller);
    if (owed === 0n) throw new Error("nothing_owed");
    const { txHash } = await this.client.withdrawMarketplaceEarnings();
    this.pushAudit({
      type: "MarketplaceWithdrawn",
      at: new Date().toISOString(),
      payload: { seller, amount: owed.toString(), txHash },
    });
    return { txHash, seller, withdrawn: owed.toString() };
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

  /**
   * Propose seating a human — a peer with a vote and a veto, not a delegate.
   *
   * High tier is not this method's choice: `GovernanceModule` takes seat admin
   * from nobody but itself, and refuses a low-tier proposal aimed at itself. The
   * orchestrator therefore cannot seat a partner on its own authority, which is
   * the point — a cloud session that could would be a second root key.
   */
  async proposeAdmitHuman(input: {
    account: `0x${string}`;
    power?: bigint;
  }): Promise<{ proposalId: string; account: `0x${string}`; txHash?: `0x${string}` }> {
    const client = this.client as {
      proposeAdmitHuman?: (i: {
        account: `0x${string}`;
        power: bigint;
      }) => Promise<{ proposalId: string; account: `0x${string}`; txHash?: `0x${string}` }>;
    };
    if (!client.proposeAdmitHuman) throw new Error("seat_admin_unsupported_by_client");
    // Weight 2 by default: the root is seeded at 2 so humans outweigh agent
    // seats, and a partner admitted at 1 would be a junior human by accident.
    const result = await client.proposeAdmitHuman({
      account: input.account,
      power: input.power ?? 2n,
    });
    this.pushAudit({
      type: "ProposalCreated",
      at: new Date().toISOString(),
      payload: {
        proposalId: result.proposalId,
        account: result.account,
        power: (input.power ?? 2n).toString(),
        action: "admit-human",
        txHash: result.txHash,
      },
    });
    return result;
  }

  /**
   * Propose revoking a human's seat. The contract refuses the last one, so this
   * lands only while another human remains seated.
   */
  async proposeRemoveHuman(input: {
    account: `0x${string}`;
  }): Promise<{ proposalId: string; account: `0x${string}`; txHash?: `0x${string}` }> {
    const client = this.client as {
      proposeRemoveHuman?: (i: {
        account: `0x${string}`;
      }) => Promise<{ proposalId: string; account: `0x${string}`; txHash?: `0x${string}` }>;
    };
    if (!client.proposeRemoveHuman) throw new Error("seat_admin_unsupported_by_client");
    const result = await client.proposeRemoveHuman({ account: input.account });
    this.pushAudit({
      type: "ProposalCreated",
      at: new Date().toISOString(),
      payload: {
        proposalId: result.proposalId,
        account: result.account,
        action: "remove-human",
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
    /** Asset stack the grant targets (symbol or token); omit for primary (USDC). */
    asset?: string;
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
        asset: input.asset,
        txHash: "txHash" in result ? result.txHash : undefined,
      },
    });
    return result;
  }

  /** Batch grant change in one governance proposal (cadence-rescale). */
  async proposeSetGrants(input: {
    entries: Array<{ account: `0x${string}`; amount: bigint }>;
    tier?: GovernanceTier;
    asset?: string;
  }): Promise<{ proposalId: string; count: number; txHash?: `0x${string}` }> {
    const result = await this.client.proposeSetGrants(input);
    this.pushAudit({
      type: "ProposalCreated",
      at: new Date().toISOString(),
      payload: {
        proposalId: result.proposalId,
        count: result.count,
        action: "setGrants",
        asset: input.asset,
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

  /**
   * Deploy a node's desired policy stack and propose binding it.
   *
   * RateLimitPolicy and TimeWindowPolicy carry their params as constructor
   * immutables, so "give this node a 5/day limit" means deploying a module
   * with those params — there is nothing to mutate. Whitelist and spend-cap
   * entries reuse the org's shared modules (their params are already
   * per-target / per-agent). Deploys are permissionless and inert; authority
   * stays with governance: binding rides a setNodePolicy proposal, plus a
   * setNodeRateRecorder proposal when the stack carries its own rate module —
   * without that binding the module's windows never fill and its limit never
   * trips.
   */
  async proposeNodePolicyStack(input: {
    node: `0x${string}`;
    modules: NodeStackModuleSpec[];
    tier?: GovernanceTier;
    /** Selects which asset stack's router + shared modules the bind targets. */
    asset?: string;
  }): Promise<{
    node: `0x${string}`;
    stack: `0x${string}`;
    deployed: Array<{ kind: string; address: `0x${string}` }>;
    reused: Array<{ kind: string; address: `0x${string}` }>;
    proposals: Array<{ action: string; proposalId: string; txHash?: `0x${string}` }>;
    /** True when the chain already binds exactly this — nothing was proposed. */
    unchanged?: boolean;
  }> {
    if (!isOnchainClient(this.client)) {
      throw new Error("policy_deploy_requires_chain");
    }
    if (input.modules.length === 0) {
      throw new Error("modules_required");
    }
    // Per-asset: every address below comes from the selected stack — its own
    // router, whitelist and spend-cap. Omitted = primary, byte-identical.
    const stackAddrs = resolveAssetStack(this.client.addresses, input.asset);

    // What the chain binds for this node today: identical rate/window modules
    // are reused instead of redeployed, and a composition that already matches
    // proposes nothing — a submit is a statement of intent, not a build log.
    const [current] = await this.client.getNodePolicies({
      nodes: [input.node],
      asset: input.asset,
    });
    const plan = planNodeStack(input.modules, current);

    const members: `0x${string}`[] = [];
    const deployed: Array<{ kind: string; address: `0x${string}` }> = [];
    const reused: Array<{ kind: string; address: `0x${string}` }> = [];
    let customRate: `0x${string}` | undefined;

    for (const { spec, reuse } of plan) {
      if (spec.kind === "whitelist") {
        if (!stackAddrs.whitelistPolicy) throw new Error("whitelistPolicy address missing");
        members.push(stackAddrs.whitelistPolicy);
      } else if (spec.kind === "spend_cap") {
        if (!stackAddrs.spendCapPolicy) throw new Error("spendCapPolicy address missing");
        members.push(stackAddrs.spendCapPolicy);
      } else if (spec.kind === "rate_limit") {
        const address =
          reuse ??
          (
            await this.client.deployRateLimitPolicy({
              maxActions: spec.maxActions,
              windowSeconds: spec.windowSeconds,
              asset: input.asset,
            })
          ).address;
        members.push(address);
        (reuse ? reused : deployed).push({ kind: "rate_limit", address });
        customRate = address;
      } else if (spec.kind === "time_window") {
        const address =
          reuse ??
          (
            await this.client.deployTimeWindowPolicy({
              startSecondOfDay: spec.startSecondOfDay,
              endSecondOfDay: spec.endSecondOfDay,
            })
          ).address;
        members.push(address);
        (reuse ? reused : deployed).push({ kind: "time_window", address });
      } else {
        throw new Error(`unknown module kind "${(spec as { kind: string }).kind}"`);
      }
    }

    const proposals: Array<{ action: string; proposalId: string; txHash?: `0x${string}` }> = [];

    // The recorder binding is checked even when the stack is unchanged: a
    // stack whose rate module never records is the exact silent failure the
    // per-node recorder exists to prevent.
    const recorderCurrent = customRate
      ? await this.client.readNodeRateRecorder(input.node, input.asset)
      : undefined;
    const recorderOk = !customRate || recorderCurrent?.toLowerCase() === customRate.toLowerCase();

    if (stackUnchanged(members, current)) {
      if (recorderOk) {
        return {
          node: input.node,
          stack: current!.policyModule,
          deployed,
          reused,
          proposals,
          unchanged: true,
        };
      }
      const recorder = await this.proposeRecorderBinding(
        input.node,
        customRate!,
        input.tier,
        input.asset,
      );
      proposals.push(recorder);
      return { node: input.node, stack: current!.policyModule, deployed, reused, proposals };
    }

    const stack = await this.client.deployPolicyStack(members);

    const bind = await this.client.proposeSetNodePolicy({
      node: input.node,
      policyModule: stack.address,
      tier: input.tier,
      asset: input.asset,
    });
    proposals.push({ action: "setNodePolicy", proposalId: bind.proposalId, txHash: bind.txHash });
    this.pushAudit({
      type: "ProposalCreated",
      at: new Date().toISOString(),
      payload: {
        proposalId: bind.proposalId,
        node: input.node,
        policyModule: stack.address,
        action: "setNodePolicy",
        txHash: bind.txHash,
      },
    });

    if (customRate && !recorderOk) {
      proposals.push(
        await this.proposeRecorderBinding(input.node, customRate, input.tier, input.asset),
      );
    }

    return { node: input.node, stack: stack.address, deployed, reused, proposals };
  }

  /** Propose EscalationRouter.setNodeRateRecorder and audit it (shared tail). */
  private async proposeRecorderBinding(
    node: `0x${string}`,
    rateRecorder: `0x${string}`,
    tier?: GovernanceTier,
    asset?: string,
  ): Promise<{ action: string; proposalId: string; txHash?: `0x${string}` }> {
    if (!isOnchainClient(this.client)) throw new Error("policy_deploy_requires_chain");
    const recorder = await this.client.proposeSetNodeRateRecorder({
      node,
      rateRecorder,
      tier,
      asset,
    });
    this.pushAudit({
      type: "ProposalCreated",
      at: new Date().toISOString(),
      payload: {
        proposalId: recorder.proposalId,
        node,
        rateRecorder,
        action: "setNodeRateRecorder",
        txHash: recorder.txHash,
      },
    });
    return {
      action: "setNodeRateRecorder",
      proposalId: recorder.proposalId,
      txHash: recorder.txHash,
    };
  }

  async proposeSetWhitelist(input: {
    target: `0x${string}`;
    allowed: boolean;
    tier?: GovernanceTier;
    asset?: string;
  }): Promise<{ proposalId: string; target: `0x${string}`; txHash?: `0x${string}` }> {
    if (!isOnchainClient(this.client)) {
      if (input.asset) {
        throw new Error(
          `Whitelist changes for a specific asset require an onchain client; ` +
            `the offline client cannot resolve "${input.asset}".`,
        );
      }
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
    /** Asset stack the cap targets (symbol or token); omit for primary (USDC). */
    asset?: string;
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
        asset: input.asset,
        txHash: result.txHash,
      },
    });
    return result;
  }

  /**
   * Vote on a proposal. With MANAGER_PRIVATE_KEY set and support=true, also casts
   * the manager seat (DeployMockOrg: root weight 2 + manager weight 1, quorum 2 —
   * the root clears quorum alone; the manager vote is recorded agent review).
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

  async vetoGovernance(
    proposalId: string,
  ): Promise<{ txHash?: `0x${string}`; proposal: GovernanceProposal }> {
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

  /**
   * Execute every proposal the chain would accept right now (F0.6 sweep).
   * The chain stays the enforcer — `decideAutoExecute` mirrors its rules only
   * to avoid burning gas on reverts, and a failed execute is logged and
   * skipped, never retried in the same pass. Chainless runtimes do nothing:
   * there is no timelock to lapse on a mock ledger.
   */
  async executeDueProposals(): Promise<{
    executed: Array<{ proposalId: string; txHash?: `0x${string}` }>;
    checked: number;
  }> {
    if (!isOnchainClient(this.client)) return { executed: [], checked: 0 };
    const [proposals, config] = await Promise.all([
      this.client.getProposals(),
      this.client.readGovernanceConfig(),
    ]);
    const now = Math.floor(Date.now() / 1000);
    const executed: Array<{ proposalId: string; txHash?: `0x${string}` }> = [];
    for (const p of proposals) {
      const decision = decideAutoExecute(p, config, now);
      if (!decision.execute) continue;
      try {
        const result = await this.executeGovernance(p.id);
        executed.push({ proposalId: p.id, txHash: result.txHash });
        console.log(
          `[@lacrew/orchestrator] auto-executed proposal ${p.id} (${decision.via})` +
            (result.txHash ? ` tx ${result.txHash}` : ""),
        );
      } catch (err) {
        // The mirror was wrong or the state moved under us; the chain said no
        // and that answer stands until the next sweep re-reads it.
        console.error(`[@lacrew/orchestrator] auto-execute of proposal ${p.id} failed:`, err);
      }
    }
    return { executed, checked: proposals.length };
  }

  /** Run the next payroll epoch (EpochStreamer onchain; mock streams caps). */
  async runEpoch(asset?: string): Promise<{ epoch: number; txHash?: `0x${string}` }> {
    const result = await this.client.runEpoch(asset);
    this.pushAudit({
      type: "AllowanceStreamed",
      at: new Date().toISOString(),
      payload: {
        epoch: result.epoch,
        asset,
        txHash: "txHash" in result ? result.txHash : undefined,
        via: "EpochStreamer",
      },
    });
    return result;
  }

  async getCurrentEpoch(asset?: string): Promise<number> {
    return this.client.getCurrentEpoch(asset);
  }

  /** Per-epoch grants configured on an asset's EpochStreamer (for cadence rescale). */
  async getGrants(asset?: string): Promise<EpochGrant[]> {
    return this.client.getGrants(asset);
  }

  /** Real per-asset treasury holdings ([] in mock mode — no real treasury). */
  async getTreasuryBalances(): Promise<TreasuryBalance[]> {
    return this.client.getTreasuryBalances();
  }

  /**
   * What each org node's own account holds, grouped by chain.
   *
   * A list of chains for a runtime that reads exactly one: the org is a
   * chain-agnostic idea and the same accounts can hold balances on several
   * chains, so consumers are given the shape a second deployment will fill
   * (F1.4) rather than one that has to be reshaped to accept it.
   *
   * [] in mock mode and when no chain is bound — an empty list says "no chain
   * answered", which is different from a chain answering that the accounts are
   * empty (that is a chain entry whose wallets all read zero).
   */
  async getAgentWallets(): Promise<ChainWallets[]> {
    if (!isOnchainClient(this.client) || this.chainId == null) return [];
    const client = this.client;
    const bound = this.chainId;
    const meta = chainMetadata(bound);

    // Watched tokens for the chain the runtime is already on ride the existing
    // read: it has the org tree and an address book, so they are simply extra
    // `balanceOf` calls rather than a second connection.
    const here = this.watchlist.find((w) => w.chainId === bound);
    const out: ChainWallets[] = [
      {
        chainId: bound,
        chainName: meta.name,
        nativeSymbol: meta.nativeSymbol,
        wallets: await client.getAgentBalances(here?.tokens ?? []),
        read: true,
        rpcSource: "configured",
      },
    ];

    // Every other watched chain needs its own connection. The accounts come
    // from the bound chain's registry — an org's seats are addresses, and an
    // address exists on every EVM chain whether or not LaCrew is deployed
    // there, which is exactly why no address book is required here.
    const foreign = this.watchlist.filter((w) => w.chainId !== bound);
    if (foreign.length === 0) return out;

    const accounts = (await client.getOrgTree()).map((n) => ({
      account: n.account,
      kind: n.kind,
      active: n.active,
    }));
    for (const watch of foreign) {
      out.push(await this.readWatchedChain(watch, accounts));
    }
    return out;
  }

  /**
   * One watched chain, read through a connection of its own.
   *
   * Every failure path returns `read: false` with a reason rather than an empty
   * wallet list, because on a balance screen those are opposite claims: "we
   * could not look" must never render as "these accounts hold nothing".
   */
  private async readWatchedChain(
    watch: WatchedChain,
    accounts: Array<{ account: `0x${string}`; kind: NodeKind; active: boolean }>,
  ): Promise<ChainWallets> {
    const meta = chainMetadata(watch.chainId);
    const base = {
      chainId: watch.chainId,
      chainName: meta.name,
      nativeSymbol: meta.nativeSymbol,
      wallets: [] as AgentWallet[],
    };

    // The operator's endpoint wins; a public one stands in when they gave none.
    // Which answered is reported, because a shared endpoint throttles and
    // "sometimes unread" is baffling until you know you are on one.
    const configured = watch.rpcUrl?.trim();
    const rpcUrl = configured || publicRpcUrl(watch.chainId);
    const rpcSource: "configured" | "public" = configured ? "configured" : "public";
    if (!rpcUrl) {
      return {
        ...base,
        read: false,
        reason: "no_rpc",
        detail: `No RPC endpoint for chain ${watch.chainId}, and no public default.`,
      };
    }

    const publicClient = createPublicClient({ transport: http(rpcUrl) });
    let reported: number;
    try {
      reported = await publicClient.getChainId();
    } catch (err) {
      return {
        ...base,
        read: false,
        rpcSource,
        reason: "unreachable",
        detail: err instanceof Error ? err.message.split("\n")[0]! : "RPC unreachable",
      };
    }

    // The same check the runtime makes at boot, for the same reason: a wrong
    // chain is worse than an unreachable one. The reads would all succeed and
    // every balance would describe somewhere else.
    if (reported !== watch.chainId) {
      return {
        ...base,
        read: false,
        rpcSource,
        reason: "chain_id_mismatch",
        detail: `Endpoint reports chain ${reported}, not ${watch.chainId}.`,
      };
    }

    try {
      return {
        ...base,
        wallets: await readAccountBalances(publicClient, accounts, watch.tokens, meta.nativeSymbol),
        read: true,
        rpcSource,
      };
    } catch (err) {
      return {
        ...base,
        read: false,
        rpcSource,
        reason: "unreachable",
        detail: err instanceof Error ? err.message.split("\n")[0]! : "Balance read failed",
      };
    }
  }

  /**
   * Read a token's own symbol/decimals on a chain we can reach.
   *
   * Uses the same endpoint resolution as a balance read — the operator's
   * endpoint when set, the public default otherwise — so a lookup succeeds
   * exactly where the balance read would.
   */
  async readWatchedToken(chainId: number, address: `0x${string}`): Promise<TokenLookup> {
    // The bound chain reads through the runtime's own client.
    if (chainId === this.chainId && isOnchainClient(this.client)) {
      return readTokenMetadata(this.client.publicClient, address);
    }
    const configured = this.watchlist.find((w) => w.chainId === chainId)?.rpcUrl?.trim();
    const rpcUrl = configured || publicRpcUrl(chainId);
    if (!rpcUrl) {
      return { ok: false, reason: "unreachable", detail: `No endpoint for chain ${chainId}.` };
    }
    try {
      const publicClient = createPublicClient({ transport: http(rpcUrl) });
      // Same guard as the balance read: metadata from the wrong chain would
      // name a token that is not the one being added.
      if ((await publicClient.getChainId()) !== chainId) {
        return { ok: false, reason: "unreachable", detail: "Endpoint is on a different chain." };
      }
      return await readTokenMetadata(publicClient, address);
    } catch (err) {
      return {
        ok: false,
        reason: "unreachable",
        detail: err instanceof Error ? err.message.split("\n")[0]! : "Endpoint unreachable",
      };
    }
  }

  /** The chains and tokens agent balances are read on. */
  getWatchlist(): WatchedChain[] {
    return this.watchlist.map((w) => ({ ...w, tokens: [...w.tokens] }));
  }

  /**
   * Replace the watchlist. The cloud pushes this on a settings change; a
   * self-hoster sets `WALLET_WATCHLIST` instead. Held in memory on purpose —
   * it is configuration the operator owns, not runtime state to reconcile.
   */
  setWatchlist(next: WatchedChain[]): void {
    this.watchlist = next.map((w) => ({ ...w, tokens: [...w.tokens] }));
  }

  /**
   * The asset stacks this org can budget in — the primary (USDC) stack plus
   * any extras from the deployment's address book. [] in mock mode: the mock
   * client models a single unnamed asset and holds no address book, and an
   * invented list would let the cloud offer a picker over stacks that do not
   * exist onchain.
   */
  listAssets(): AssetStack[] {
    if (!isOnchainClient(this.client)) return [];
    return listAssetStacks(this.client.addresses);
  }

  /**
   * Per-node policy-stack composition read from the chain — which module
   * EscalationRouter binds for each node and what each module in it enforces
   * (caps, whitelist targets, rate, window). [] in mock mode: the offline
   * client has no policy contracts to read, and an invented stack would be a
   * claim about what an agent is allowed to spend. An asset selector in mock
   * mode throws (→ 400 at the route) like every other asset-scoped read.
   */
  async getNodePolicies(
    opts: { asset?: string; node?: `0x${string}` } = {},
  ): Promise<NodePolicyStack[]> {
    if (!isOnchainClient(this.client)) {
      if (opts.asset) {
        throw new Error(
          `Policy reads for a specific asset require an onchain client; ` +
            `the offline client cannot resolve "${opts.asset}".`,
        );
      }
      return [];
    }
    return this.client.getNodePolicies({
      asset: opts.asset,
      nodes: opts.node ? [opts.node] : undefined,
    });
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
    /*
      Stamp a monotonic sequence before the event goes anywhere.

      `audit()` dedupes on type + intent/tx/value + timestamp, which is right
      for chain events — the same log arriving from the local ring, the store
      and the indexer must collapse to one row. Off-chain events carry no
      intent id, tx hash or value, so that key reduces to type + timestamp, and
      two of the same kind raised in the same millisecond collapsed into one:
      the trail asserted a single change where two had happened. Two directive
      edits, two flow runs, two tool calls.

      The sequence distinguishes them without weakening the chain-event case,
      because it rides in the payload and travels with the event into the
      store — so a persisted copy of the same event still matches its local
      original and still dedupes.
    */
    this.auditSeq += 1;
    event = { ...event, payload: { ...event.payload, seq: this.auditSeq } };
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
