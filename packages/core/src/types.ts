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
  /** Human-seat yes votes (high-tier quorum). */
  yesHumanVotes?: number;
  deadline: number;
  eta: number;
  state: GovernanceProposalState;
}

/** Seat classification in GovernanceModule. Agent yes-weight counts for low tier only. */
export type GovernanceSeatRole = "none" | "human" | "agent";

/**
 * A seat in the electorate as GovernanceModule holds it.
 *
 * `power` is the weight the contract applies when this address votes; zero
 * means it cannot vote at all (`vote()` reverts `NoVotingPower`). Only `human`
 * seats accrue to `yesHumanVotes`, which is the sole gate for high-tier
 * execution — an agent seat can help carry a low-tier proposal but can never
 * satisfy a high-tier one.
 */
export interface GovernanceSeat {
  voter: `0x${string}`;
  /** Weight as the contract stores it. String to avoid precision loss. */
  power: string;
  role: GovernanceSeatRole;
}

/** Quorum thresholds and the root that may change them. All weights, not counts. */
export interface GovernanceConfig {
  /** Configured all-seat yes-weight for low tier. */
  quorumYes: string;
  /** Configured human-seat yes-weight for high tier. */
  quorumHumanYes: string;
  /**
   * The address that may call `setQuorum*` / `setTiming` and administer *agent*
   * seats directly, without a proposal — and only while it still holds a funded
   * human seat of its own (or while the org has seated no human at all, the
   * bootstrap of a module deployed with zero root weight).
   *
   * Human seats are not in its gift: creating, re-weighting or revoking one runs
   * through `admitHuman` / `removeHuman`, which accept the module itself as
   * caller and nobody else. So the root cannot vote itself more weight, cannot
   * add a partner unseen, and cannot fire one.
   */
  humanRoot: `0x${string}`;
  /** Sum of all seat weight currently granted. */
  totalVotingPower?: string;
  /** Sum of human-seat weight; also defines unanimity for the fast path. */
  totalHumanVotingPower?: string;
  /**
   * How many funded human seats exist — heads, not weight. One means this org
   * has a single point of human failure; the contract refuses to let it reach
   * zero, since agent yes-weight never satisfies high-tier final say.
   */
  humanSeatCount?: string;
  /**
   * Quorum `execute()` actually enforces: the configured value clamped to the
   * seated weight, so a bootstrap org is never asked for voters that do not
   * exist. Display these, not the configured values, as the bar to clear.
   */
  effectiveQuorumYes?: string;
  effectiveQuorumHumanYes?: string;
  /** Voting window in seconds applied to proposals at creation. */
  votingPeriod?: number;
  /** High-tier delay in seconds after the voting deadline. May be zero. */
  highTierTimelock?: number;
  /** When true, unanimous human yes-weight executes high tier without waiting. */
  unanimityFastPath?: boolean;
}

export interface OrgNode {
  account: `0x${string}`;
  kind: NodeKind;
  parent: `0x${string}` | null;
  active: boolean;
  /** Display label for UIs; not stored onchain. */
  label?: string;
  /**
   * Blueprint role id this seat was hired as, when something recorded one
   * (F2.25). Not stored onchain either — and unlike the label it is stable, so
   * it is what a seat is found by after somebody renames it.
   */
  roleId?: string;
}

export interface Allowance {
  node: `0x${string}`;
  /** Token address; Mocked zero address means synthetic units. */
  token: `0x${string}`;
  balance: bigint;
  epoch: number;
  /**
   * The ceiling SpendCapPolicy will enforce for this agent — its own cap, or
   * the module default it inherits. Both are equally binding.
   *
   * Null means the dimension is not enforced at all (no SpendCapPolicy in the
   * stack), not "no limit set for this agent".
   *
   * Previously the onchain read reported `cap: balance`, so every agent
   * appeared to be spending exactly to its limit no matter what the policy
   * actually allowed.
   */
  cap: bigint | null;
}

/**
 * One node's per-epoch grant on an EpochStreamer — the amount streamed into its
 * allowance each payroll run. `amount` is the asset's base units as an exact
 * string (never a float), so it can be rescaled with BigInt when cadence changes.
 */
export interface EpochGrant {
  account: `0x${string}`;
  amount: string;
}

/** Human-readable preflight of the agent's intended action (PRD F1.16). */
export type IntentSimulation = {
  status: "ok" | "warning" | "revert";
  /**
   * Present only when something actually estimated gas.
   *
   * Absent is a real state and must stay renderable as one. A number derived
   * from the spend amount used to fill this in, sitting beside a status and
   * warnings that come from genuine allowance and policy reads — which made
   * the invented figure read as measured.
   */
  gasEstimate?: string;
  assetChanges: Array<{ asset: string; delta: string; direction: "in" | "out" }>;
  /**
   * Balance movements MEASURED by executing the approval inside a simulated
   * block (eth_simulateV1): every org asset token probed on the parties the
   * intent names, before vs. after, exact base units. Distinct from
   * `assetChanges`, which is the heuristic reading of the intent's own value —
   * these are what the chain would actually do, including anything the target
   * call moves on the side. Absent when the node cannot simulate a block —
   * absent is "not measured", never "no movement".
   */
  measuredChanges?: Array<{
    account: `0x${string}`;
    /** Which party this is from the intent's point of view. */
    label: "treasury" | "agent" | "target" | "router";
    asset: string;
    /** Signed base-unit delta as an exact string. */
    delta: string;
    decimals: number;
  }>;
  /**
   * The approval's internal call tree (debug_traceCall callTracer), flattened
   * depth-first and bounded: which contracts execute, in order, with the
   * native value each frame carried and any revert it hit. Absent when the
   * node exposes no tracer — absent is "not traced", never "no calls".
   */
  callTrace?: Array<{
    depth: number;
    type: string;
    from: `0x${string}`;
    to: `0x${string}`;
    /** Native value the frame carried, base units as a string ("0" common). */
    value: string;
    gasUsed?: string;
    error?: string;
  }>;
  warnings: string[];
};

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
  /** Attached at propose time for approver UX (mock heuristic or viem sim). */
  simulation?: IntentSimulation;
  /**
   * Set when the event announcing this intent was seen but its onchain row
   * could not be read, so `target`, `value` and `data` are unknown.
   *
   * The intent is still listed: it exists, somebody is waiting on it, and
   * dropping it would hide a pending approval. But an approver decides on the
   * target and the amount, so those must never be filled in with zeros — that
   * renders as "0 USDC → 0x0000…0000", which is a spend request nobody made.
   */
  unreadable?: boolean;
}

/**
 * Whose signature a pending intent's next decision needs (PRD F2.6).
 *
 * `EscalationRouter.resolve` reverts for any sender that is not the intent's
 * `awaitingApprover`, so this is a read of the chain's own gate rather than a
 * policy this stack invents. `isRoot` is what decides whether a fresh root
 * proof is demanded before anything is signed: an intent that has climbed to
 * the human root is settled by the human, not by whichever key the
 * orchestrator happens to hold.
 */
export interface ApprovalAuthority {
  /** False when the intent is not pending — never read as "no proof needed". */
  found: boolean;
  awaitingApprover: `0x${string}` | null;
  isRoot: boolean;
}

/**
 * The scopes a session key can carry. Closed on purpose: SessionRegistry
 * rejects a mask with any bit it does not know, so a scope invented here
 * without a matching bit onchain would be refused at issue time rather than
 * silently granting nothing.
 */
export type SessionScope = "propose:intent" | "spend:whitelist";

/** Bit positions, mirroring `SessionRegistry.SCOPE_*`. */
export const SESSION_SCOPE_BIT: Record<SessionScope, number> = {
  "propose:intent": 1 << 0,
  "spend:whitelist": 1 << 1,
};

export const SESSION_SCOPES = Object.keys(SESSION_SCOPE_BIT) as SessionScope[];

export function isSessionScope(value: string): value is SessionScope {
  return value in SESSION_SCOPE_BIT;
}

/**
 * Encode scopes for `SessionRegistry.issue`. Throws on an unknown scope: a
 * silently dropped scope would issue a key with less authority than the caller
 * asked for, which fails later and far from the cause.
 */
export function sessionScopeMask(scopes: readonly string[]): bigint {
  let mask = 0n;
  for (const scope of scopes) {
    if (!isSessionScope(scope)) {
      throw new Error(
        `unknown session scope "${scope}" — known scopes: ${SESSION_SCOPES.join(", ")}`,
      );
    }
    mask |= BigInt(SESSION_SCOPE_BIT[scope]);
  }
  return mask;
}

/** Decode a mask back to scope names, for display and persistence. */
export function sessionScopesFromMask(mask: bigint): SessionScope[] {
  return SESSION_SCOPES.filter((scope) => (mask & BigInt(SESSION_SCOPE_BIT[scope])) !== 0n);
}

/** What a propose would be checked against, for `policyForcesEscalation`. */
export interface EscalationProofContext {
  /** The call's value, in the stack's base units. */
  value: bigint;
  /** Unix seconds the propose is expected to be mined at. */
  nowSec: number;
  /**
   * How much of a live rate window must remain before its ESCALATE is relied on.
   *
   * A rate limit's verdict is time-dependent: the window resets, and `check`
   * goes back to ALLOW. Reading it here and mining the propose later means the
   * verdict can flip in between, which would leave a narrowed key unable to
   * settle a call the policy now allows. The margin is how much of that gap the
   * proof refuses to bet on.
   */
  rateWindowMarginSec: number;
}

/**
 * Whether this policy stack provably escalates the described call.
 *
 * Sound only because of two contract facts together: `PolicyStack.check` returns
 * ESCALATE if *any* member escalates, and `EscalationRouter.proposeIntent`
 * reaches `_requireSpendScope` only on ALLOW. So a single escalating member
 * settles the verdict no matter what else is in the stack — including modules
 * this reader could not classify, which can only ever be more restrictive.
 *
 * Only two of the reference modules can produce ESCALATE, and both are checked:
 * `SpendCapPolicy` (value over `capOf`) and `RateLimitPolicy` (allowance spent
 * inside a live window). `WhitelistPolicy` and `TimeWindowPolicy` return DENY
 * instead, which short-circuits the stack and reverts the propose — that call
 * never reaches a scope check, so there is no narrowing to justify.
 *
 * Nested stacks are walked, since a module one level down is enforced just as
 * hard as a top-level one.
 *
 * False means "not proven", never "will be allowed": anything unread leaves the
 * caller with no proof to act on, which is the safe direction.
 */
export function policyForcesEscalation(
  modules: readonly PolicyModuleInfo[],
  ctx: EscalationProofContext,
): boolean {
  for (const module of modules) {
    if (module.kind === "spend_cap" && module.cap !== undefined) {
      // A cap that does not parse is treated as unread rather than as zero,
      // which would claim every call escalates.
      try {
        if (ctx.value > BigInt(module.cap)) return true;
      } catch {
        // not a readable cap; keep walking
      }
    }

    if (module.kind === "rate_limit" && rateLimitForcesEscalation(module, ctx)) return true;

    if (module.modules && module.modules.length > 0) {
      if (policyForcesEscalation(module.modules, ctx)) return true;
    }
  }
  return false;
}

/**
 * `RateLimitPolicy.check` escalates only while a window is live *and* its count
 * has reached `maxActions`. Both conditions have to be readable, and the window
 * has to have enough life left that it cannot lapse before the propose lands.
 */
function rateLimitForcesEscalation(module: PolicyModuleInfo, ctx: EscalationProofContext): boolean {
  const { maxActions, windowSeconds, windowStartSec, actionsUsed } = module;
  if (
    maxActions === undefined ||
    windowSeconds === undefined ||
    windowStartSec === undefined ||
    actionsUsed === undefined
  ) {
    return false;
  }
  // No window recorded yet: the contract's first branch returns ALLOW.
  if (windowStartSec <= 0) return false;
  // Allowance left inside the window is an ALLOW too.
  if (actionsUsed < maxActions) return false;

  const windowEndsSec = windowStartSec + windowSeconds;
  // Already lapsed: `check` starts a fresh window and allows.
  if (ctx.nowSec >= windowEndsSec) return false;
  // Close enough to lapsing that the propose could land after the reset.
  return windowEndsSec - ctx.nowSec > ctx.rateWindowMarginSec;
}

/**
 * Drop `spend:whitelist` when the chain cannot reach settlement anyway.
 *
 * `EscalationRouter.proposeIntent` requires `propose:intent` on every call and
 * reaches `_requireSpendScope` only on an ALLOW verdict. When the verdict is
 * provably ESCALATE, a key carrying settlement authority is authority the call
 * can never use — so the narrower key does the same work.
 *
 * Derived from `standing` rather than assembled from scratch, which makes
 * widening impossible: the result is always a subset of what the agent already
 * had. Returns `standing` unchanged when there is nothing to prove or nothing
 * left to drop — an empty mask is refused at issue, so narrowing to nothing
 * would be an outage rather than a restriction.
 */
export function narrowScopesForEscalation(
  standing: readonly SessionScope[],
  forcesEscalation: boolean,
): SessionScope[] {
  if (!forcesEscalation) return [...standing];
  const narrowed = standing.filter((scope) => scope !== "spend:whitelist");
  return narrowed.length > 0 ? narrowed : [...standing];
}

export interface SessionKey {
  agent: `0x${string}`;
  /** Session id (onchain uint as string, or mock UUID). */
  keyId: string;
  expiresAt: number;
  /** Enforced by EscalationRouter via the onchain scope mask. */
  scopes: SessionScope[];
  /** Ephemeral EOA address registered onchain (when issued via SessionRegistry). */
  keyAddress?: `0x${string}`;
  /** Onchain max propose value (decimal string); enforced by EscalationRouter. */
  maxValue?: string;
  /** Sole allowed target (`0x0…0` / omit = any policy-allowed target). */
  allowedTarget?: `0x${string}`;
  /**
   * Every target pinned to the key. `allowedTarget` is the first of these, kept
   * so a naive consumer fails closed; a caller that must preserve the key's real
   * reach — rotation, above all — reads this. Omitted when unpinned or unread.
   */
  allowedTargets?: `0x${string}`[];
  /**
   * Daily allowed window in seconds since midnight UTC, `[start, end)`, enforced
   * by EscalationRouter. Omitted when the key has no window (any time).
   */
  window?: { start: number; end: number };
  /**
   * Propose rate limit enforced by EscalationRouter: at most `maxProposals` per
   * `ratePeriod` seconds. Omitted when the key has no rate limit.
   */
  rate?: { maxProposals: number; ratePeriod: number };
  /** true when revoked onchain or locally. */
  revoked?: boolean;
  /** Account-level delegation riding this session, when a provider issued one. */
  delegation?: SessionDelegation;
}

/**
 * A budget-caveated, expiring delegation from an agent's seat account to a
 * session key (F1.3, MetaMask Delegation Toolkit path). Account-level
 * enforcement that rides alongside — never instead of — the SessionRegistry
 * + EscalationRouter path: the chain checks both.
 */
export interface SessionDelegation {
  /** Which provider issued it, e.g. "metamask". */
  provider: string;
  /** The delegator seat account (smart account, root-owned today). */
  seat: `0x${string}`;
  /** True once the seat has code; a delegation redeems only against code. */
  seatDeployed: boolean;
  /** The session key the delegation is bound to. */
  delegate: `0x${string}`;
  delegationManager: `0x${string}`;
  chainId: number;
  budget: {
    kind: "erc20Total" | "nativeTotal";
    /** Budget token; absent for native. */
    token?: `0x${string}`;
    /** Raw amount as a decimal string (BigInt-safe). */
    amount: string;
  };
  /** Unix seconds — matches the session's expiry via a timestamp caveat. */
  expiresAtSec: number;
  /** Provider-issue salt (the agent), so revocation can rebuild the seat. */
  salt: string;
  /**
   * The signed delegation, opaque here — the provider owns its encoding.
   * Present on the held/persisted record (revocation needs it); stripped
   * from read surfaces, where budget and state are the whole story.
   */
  signed?: Record<string, unknown>;
  /** True after an onchain disable actually landed — never assumed. */
  disabled?: boolean;
}

/** A transaction built by a provider for the caller to broadcast. */
export interface BuiltTx {
  to: `0x${string}`;
  data: `0x${string}`;
  value: bigint;
}

/**
 * Issues and revokes account-level session delegations. Implementations live
 * in wallet adapter packages; the orchestrator only sees this seam.
 */
export interface DelegationProvider {
  readonly provider: string;
  /**
   * Build and sign a delegation from the agent's seat to the session key,
   * bounded by `maxValue` and expiring with the session. `seatDeployTx` is
   * present when the seat has no code yet — redemption needs the deploy.
   */
  issue(args: {
    agent: `0x${string}`;
    sessionKey: `0x${string}`;
    maxValue: bigint;
    expiresAtSec: number;
  }): Promise<{ delegation: SessionDelegation; seatDeployTx?: BuiltTx }>;
  /**
   * One plain transaction that disables the delegation onchain (self-bundled
   * EntryPoint.handleOps — permissionless, no bundler service). Broadcasting
   * is the caller's job; only a landed receipt makes `disabled` true.
   */
  buildRevokeTx(delegation: SessionDelegation, beneficiary: `0x${string}`): Promise<BuiltTx>;
}

/**
 * One asset's enforcement stack.
 *
 * A `Treasury` binds one immutable ERC-20 (SPEC §4.1), so an org funds N assets
 * by deploying one Treasury + EscalationRouter + EpochStreamer per asset over a
 * single shared `OrgRegistry`. The org chart stays one tree; enforcement is
 * asset-scoped. Multi-asset above the contracts is therefore address
 * *resolution* — "point at this asset's stack" — not a token argument on
 * `setGrant`.
 *
 * Policy stacks are asset-denominated: a `SpendCapPolicy` compares raw
 * `uint256`, so a 100 USDC cap (`100e6`) is dust against an 18-decimal asset.
 * `decimals` is carried so callers denominate caps and grants correctly.
 */
export interface AssetStack {
  /** Display symbol, e.g. "USDC", "WETH". Case-insensitive selector key. */
  symbol: string;
  /** ERC-20 the stack is denominated in; also a selector key. */
  token: `0x${string}`;
  /** Token decimals — grants and caps are denominated in these units. */
  decimals: number;
  /** Treasury holding this asset and streaming its allowances. */
  treasury: `0x${string}`;
  /** Router enforcing this asset's policy stack and pending intents. */
  escalationRouter: `0x${string}`;
  /** Payroll streamer feeding this asset's allowances. */
  epochStreamer: `0x${string}`;
  spendCapPolicy?: `0x${string}`;
  whitelistPolicy?: `0x${string}`;
  policyStack?: `0x${string}`;
}

/**
 * One asset's treasury holdings, read from that asset's own `Treasury`.
 *
 * `total` is `token.balanceOf(treasury)` — everything the treasury holds;
 * `reserved` is `totalReserved()` — the sum already committed to node
 * allowances; `liquid` is `liquidBalance()` — the unreserved remainder. All are
 * in the asset's own base units (see `decimals`).
 */
export interface TreasuryBalance {
  symbol: string;
  token: `0x${string}`;
  decimals: number;
  total: bigint;
  liquid: bigint;
  reserved: bigint;
}

/**
 * One asset an account holds: the chain's own coin, or an ERC-20.
 *
 * `symbol` is nullable because nothing onchain names a chain coin — it comes
 * from the chain metadata table, which only knows the chains this repo ships
 * address books for. An unrecognised chain reports `null` rather than assuming
 * ETH, since "ETH" on a chain whose coin is not ether is a wrong number with a
 * confident label.
 */
export interface AgentAssetBalance {
  symbol: string | null;
  /** ERC-20 contract, or the literal `"native"` for the chain coin. */
  token: `0x${string}` | "native";
  decimals: number;
  /** Base units, in this asset's own `decimals`. */
  balance: bigint;
}

/**
 * What one org node's own account holds.
 *
 * Distinct from its allowance: an allowance is what the Treasury has reserved
 * for the node and will release through the policy path, while this is the
 * balance sitting in the account itself — including the native float it needs
 * to pay for its own gas, which no allowance covers.
 *
 * `tokens` carries one row per ERC-20 the deployment's address book names,
 * including zero balances: "this agent holds no USDC" is an answer, and
 * dropping the row would make it indistinguishable from "we did not look".
 */
export interface AgentWallet {
  account: `0x${string}`;
  kind: NodeKind;
  active: boolean;
  native: AgentAssetBalance;
  tokens: AgentAssetBalance[];
}

/**
 * Agent wallets on one chain.
 *
 * A list because the org is a chain-agnostic idea and the same accounts can
 * hold balances on several chains. One client reads one chain, so a single
 * runtime contributes exactly one entry — the shape is what lets a second
 * deployment be added without reshaping every consumer (F1.4).
 */
export interface ChainWallets {
  chainId: number;
  /** Display name when the chain is one we ship metadata for; else `null`. */
  chainName: string | null;
  /** Chain coin symbol when known; `null` rather than an assumed "ETH". */
  nativeSymbol: string | null;
  wallets: AgentWallet[];
  /**
   * Whether the chain actually answered.
   *
   * The distinction this whole feature turns on. A watched chain with no RPC,
   * or one that timed out, must never render as accounts holding zero — that is
   * a fabricated balance on the one screen where a fabricated balance is worst.
   * `read: false` means `wallets` says nothing at all.
   */
  read: boolean;
  /**
   * Which endpoint answered (or was tried). A public endpoint is shared and
   * rate-limited, so a chain that reads intermittently is explained by this
   * rather than looking like a bug — and it is also the privacy signal: a
   * public endpoint learns which addresses the operator cares about.
   */
  rpcSource?: "configured" | "public";
  /** Why the chain could not be read. Absent when `read` is true. */
  reason?: "no_rpc" | "unreachable" | "chain_id_mismatch";
  /** Detail for `reason` — an operator has to be able to fix it. */
  detail?: string;
}

/** An ERC-20 to read on a chain regardless of any address book. */
export interface WatchedToken {
  symbol: string;
  address: `0x${string}`;
  decimals: number;
}

/**
 * One chain an operator wants agent balances read on.
 *
 * `rpcUrl` is what makes the chain readable. Watching a chain without one is a
 * legitimate state — it says "we care about this chain and cannot see it yet",
 * which is information — so it is optional rather than required, and the read
 * reports `read: false` instead of inventing zeros.
 */
export interface WatchedChain {
  chainId: number;
  /** Read-only JSON-RPC endpoint. Absent = watched but unreadable. */
  rpcUrl?: string;
  /** Tokens to read here, beyond whatever the address book already names. */
  tokens: WatchedToken[];
}

/**
 * What a policy module was identified as by probing its distinctive getters.
 *
 * `IPolicyModule` carries no `kind()` discriminator, so classification probes
 * each candidate getter (`moduleCount` → stack, `defaultCap` → spend cap, …)
 * and reports `unknown` — with the address, never a guess — when none answers.
 */
export type PolicyModuleKind =
  "spend_cap" | "whitelist" | "rate_limit" | "time_window" | "stack" | "unknown";

/**
 * One policy module in a node's stack, with the parameters it enforces.
 *
 * Amounts are base-unit strings (same rule as `EpochGrant.amount`) so they
 * survive JSON and stay exact. Fields are per-kind: only the ones for `kind`
 * are set.
 */
export interface PolicyModuleInfo {
  address: `0x${string}`;
  kind: PolicyModuleKind;
  /** spend_cap: module-wide fallback cap (base units). */
  defaultCap?: string;
  /**
   * spend_cap: the per-call ceiling `check()` will actually enforce for the
   * queried node (`capOf` — the inherited default is every bit as binding as
   * an explicit cap).
   */
  cap?: string;
  /** spend_cap: whether `cap` is an explicit per-agent cap (`hasAgentCap`). */
  capIsExplicit?: boolean;
  /**
   * whitelist: targets currently allowed. The mapping is not enumerable, so
   * candidates come from `TargetAllowed` logs and each is re-read from state —
   * a since-revoked target is never reported as live.
   */
  allowedTargets?: `0x${string}`[];
  /** rate_limit: max proposals per window. */
  maxActions?: number;
  /** rate_limit: window length in seconds. */
  windowSeconds?: number;
  /**
   * rate_limit: start of the queried node's current window, unix seconds, or 0
   * when it has never proposed. Per-node state, like `cap` — the module's limits
   * are shared, the usage against them is not.
   */
  windowStartSec?: number;
  /** rate_limit: proposals the queried node has already made in that window. */
  actionsUsed?: number;
  /** time_window: daily UTC window start, in seconds of day. */
  startSecondOfDay?: number;
  /** time_window: daily UTC window end (exclusive), in seconds of day. */
  endSecondOfDay?: number;
  /** stack: nested members in `check()` order (a stack may nest a stack). */
  modules?: PolicyModuleInfo[];
}

/**
 * The policy stack EscalationRouter enforces for one org node.
 *
 * `source` records how the binding resolved: a per-node `policyOf` override,
 * or the router's default `policy` — the fallback the contract applies
 * silently (`_policyFor`), which the read makes visible.
 */
export interface NodePolicyStack {
  node: `0x${string}`;
  /** The bound IPolicyModule (a PolicyStack or a single module). */
  policyModule: `0x${string}`;
  source: "node" | "default";
  /**
   * The binding expanded: a PolicyStack's members in `check()` order, or a
   * single-element list when the bound module is not a stack.
   */
  modules: PolicyModuleInfo[];
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
  /** Manager-node stack (no rate limit); worker uses `policyStack`. */
  managerPolicyStack?: `0x${string}`;
  whitelistPolicy?: `0x${string}`;
  /** Daily UTC window policy in the default worker stack (full-day = always open). */
  timeWindowPolicy?: `0x${string}`;
  epochStreamer?: `0x${string}`;
  sessionRegistry?: `0x${string}`;
  /** USDC settlement for marketplace sales. Independent of Treasury by design. */
  marketplacePayments?: `0x${string}`;
  /** Org node accounts seeded by DeployMockOrg. */
  humanRoot?: `0x${string}`;
  manager?: `0x${string}`;
  worker?: `0x${string}`;
  x402Target?: `0x${string}`;
  /**
   * Additional asset stacks beyond the primary one.
   *
   * The flat `treasury` / `escalationRouter` / `epochStreamer` fields above are
   * the **primary** asset stack (USDC on the reference deploy). Each entry here
   * is a full independent stack — its own Treasury, EscalationRouter and
   * EpochStreamer over the shared `orgRegistry` — for a different token. Resolve
   * one with `resolveAssetStack(addresses, symbolOrToken)`.
   */
  assets?: AssetStack[];
}
