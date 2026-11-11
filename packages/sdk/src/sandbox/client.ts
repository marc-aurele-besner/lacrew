/**
 * The sandbox client: the `ProtocolClient` surface answered by the kernel
 * instead of a chain.
 *
 * There are no keys here. Where the onchain client signs with a wallet, this
 * one names a sender: `msg.sender` is the `account` argument of the call, or
 * the account the client was created for. Every write commits one atomic
 * kernel transaction and is named by a `simTxId`, never a `txHash`.
 */

import { encodeFunctionData, keccak256, toBytes, type Account } from "viem";
import {
  epochStreamerAbi,
  escalationRouterAbi,
  governanceModuleAbi,
  listAssetStacks,
  orgRegistryAbi,
  resolveAssetStack,
  sessionScopesFromMask,
  spendCapPolicyAbi,
  whitelistPolicyAbi,
  type Allowance,
  type ChainAddresses,
  type EpochGrant,
  type GovernanceConfig,
  type GovernanceProposal,
  type GovernanceProposalState,
  type GovernanceSeat,
  type GovernanceSeatRole,
  type GovernanceTier,
  type Intent,
  type NodePolicyStack,
  type OrgNode,
  type PolicyModuleInfo,
  type ProtocolEvent,
  type SessionKey,
  type TreasuryBalance,
  type Verdict,
} from "@lacrew/core";

import type {
  IssueSessionInput,
  ProtocolClient,
  ProtocolResolveResult,
  SessionKeyLimits,
  WriteRef,
} from "../protocolClient.js";
import { SandboxNeedsChainError, abiEnv, callByAddress, type CallOutcome } from "./calldata.js";
import {
  MAX_UINT256,
  SimRevert,
  ZERO_ADDRESS,
  addr,
  allocateAddress,
  deserializeWorld,
  epochStreamer,
  escalationRouter,
  genesis,
  governance,
  orgRegistry,
  policies,
  serializeWorld,
  sessionRegistry,
  token,
  transact,
  treasury,
  type Address,
  type Clock,
  type Ctx,
  type GenesisParams,
  type Hex,
  type JsonValue,
  type SimEvent,
  type World,
} from "./kernel/index.js";

const KIND_FROM: Record<number, OrgNode["kind"]> = {
  0: "human_root",
  1: "manager_agent",
  2: "worker_agent",
};
const KIND_TO: Record<OrgNode["kind"], number> = {
  human_root: 0,
  manager_agent: 1,
  worker_agent: 2,
};
const VERDICT_FROM: Record<number, Verdict> = { 0: "ALLOW", 1: "ESCALATE", 2: "DENY" };
const TIER_TO: Record<GovernanceTier, number> = { low: 0, high: 1 };
const TIER_FROM: Record<number, GovernanceTier> = { 0: "low", 1: "high" };
const STATE_FROM: Record<number, GovernanceProposalState> = {
  0: "active",
  1: "executed",
  2: "vetoed",
  3: "defeated",
};
const SEAT_ROLE_FROM: Record<number, GovernanceSeatRole> = { 0: "none", 1: "human", 2: "agent" };

/** How many audit events the client keeps in memory. */
const AUDIT_RING_MAX = 1_000;

/** A sandbox's whole persistent state: the world and how many transactions made it. */
export interface SandboxSnapshot {
  version: 1;
  txCount: number;
  world: JsonValue;
}

/** One committed transaction, as handed to `onCommit`. */
export interface SandboxCommit {
  simTxId: string;
  sender: Address;
  /** Unix seconds the transaction ran at. */
  at: number;
  events: SimEvent[];
  /** The state after the transaction, ready to persist. */
  snapshot(): SandboxSnapshot;
}

export interface SandboxClientOptions {
  /**
   * The org's human root. Required to deploy a fresh sandbox; ignored when
   * `snapshot` restores an existing one.
   */
  root?: Address;
  /** Restore this state instead of deploying genesis. */
  snapshot?: SandboxSnapshot;
  /** The sandbox's only source of time. */
  clock: Clock;
  /** Default sender for writes. Defaults to the human root. */
  account?: Address;
  /** Sender for `resolveIntent` when the intent names no approver. Defaults to `account`. */
  resolverAccount?: Address;
  /** Sender for session issuance and revocation. Defaults to `account`. */
  issuerAccount?: Address;
  /** Overrides for the genesis deployment (caps, rate limit, time window). */
  genesis?: Partial<Omit<GenesisParams, "root" | "at" | "env">>;
  /** Called after every committed transaction, in commit order. */
  onCommit?: (commit: SandboxCommit) => void;
}

/** State shared by every view of one sandbox (see `SandboxLacrewClient.as`). */
interface Ledger {
  world: World;
  txCount: number;
  clock: Clock;
  audit: ProtocolEvent[];
  onCommit?: (commit: SandboxCommit) => void;
}

function simTxId(n: number): string {
  return `simtx_${n.toString().padStart(8, "0")}`;
}

/** A kernel event as the audit trail's `ProtocolEvent`, or null when the trail has no row for it. */
function toProtocolEvent(event: SimEvent, at: string, txId: string): ProtocolEvent | null {
  const a = event.args;
  const base = { at, payload: { simTxId: txId } as Record<string, unknown> };
  const with_ = (type: ProtocolEvent["type"], payload: Record<string, unknown>): ProtocolEvent => ({
    type,
    at: base.at,
    payload: { ...payload, ...base.payload },
  });
  switch (`${event.contract}.${event.name}`) {
    case "EscalationRouter.IntentCreated":
      return with_("IntentCreated", {
        intentId: String(a.intentId),
        agent: a.agent,
        awaitingApprover: a.awaitingApprover,
      });
    case "EscalationRouter.IntentEscalated":
      return with_("IntentEscalated", { intentId: String(a.intentId), from: a.from, to: a.to });
    case "EscalationRouter.IntentResolved":
      return with_("IntentResolved", { intentId: String(a.intentId), approved: a.approved });
    case "EscalationRouter.ActionExecuted":
      return with_("ActionExecuted", {
        agent: a.agent,
        target: a.target,
        value: String(a.value),
        callOk: a.callOk,
      });
    case "Treasury.AllowanceStreamed":
      return with_("AllowanceStreamed", {
        node: a.node,
        amount: String(a.amount),
        epoch: Number(a.epoch),
      });
    case "Treasury.AllowanceSpent":
      return with_("AllowanceSpent", { agent: a.node, target: a.to, value: String(a.amount) });
    case "Treasury.Deposited":
      return with_("TreasuryDeposit", { from: a.from, amount: String(a.amount) });
    case "GovernanceModule.ProposalCreated":
      return with_("ProposalCreated", {
        proposalId: String(a.proposalId),
        proposer: a.proposer,
        tier: a.tier,
        target: a.target,
        actionHash: a.actionHash,
      });
    case "GovernanceModule.Voted":
      return with_("ProposalVoted", {
        proposalId: String(a.proposalId),
        voter: a.voter,
        support: a.support,
        weight: String(a.weight),
      });
    case "GovernanceModule.ProposalExecuted":
      return with_("ProposalExecuted", { proposalId: String(a.proposalId) });
    case "GovernanceModule.ProposalDefeated":
      return with_("ProposalDefeated", { proposalId: String(a.proposalId) });
    case "GovernanceModule.ProposalVetoed":
      return with_("ProposalVetoed", { proposalId: String(a.proposalId), vetoer: a.vetoer });
    case "SessionRegistry.SessionIssued":
      return with_("SessionIssued", {
        keyId: String(a.sessionId),
        agent: a.agent,
        keyAddress: a.key,
        expiresAt: Number(a.expiresAt) * 1000,
        maxValue: String(a.maxValue),
        allowedTarget: a.allowedTarget,
      });
    case "SessionRegistry.SessionRevoked":
      return with_("SessionRevoked", { keyId: String(a.sessionId), by: a.by });
    default:
      return null;
  }
}

export class SandboxLacrewClient implements ProtocolClient {
  readonly ledger = "sandbox" as const;
  /** Default `msg.sender` of this view's writes. */
  readonly account: Address;
  readonly resolverAccount: Address;
  readonly issuerAccount: Address;

  private constructor(
    private readonly state: Ledger,
    accounts: { account: Address; resolverAccount: Address; issuerAccount: Address },
  ) {
    this.account = accounts.account;
    this.resolverAccount = accounts.resolverAccount;
    this.issuerAccount = accounts.issuerAccount;
  }

  static create(options: SandboxClientOptions): SandboxLacrewClient {
    let world: World;
    let txCount = 0;
    if (options.snapshot) {
      if (options.snapshot.version !== 1) {
        throw new Error("not a sandbox snapshot this client can read (expected version 1)");
      }
      world = deserializeWorld(options.snapshot.world);
      txCount = options.snapshot.txCount;
    } else {
      if (!options.root) throw new Error("a new sandbox needs the org's human root address");
      world = genesis({
        ...options.genesis,
        root: options.root,
        at: options.clock,
        env: abiEnv,
      });
    }
    const root = world.orgRegistry.root;
    const account = addr(options.account ?? root);
    return new SandboxLacrewClient(
      { world, txCount, clock: options.clock, audit: [], onCommit: options.onCommit },
      {
        account,
        resolverAccount: addr(options.resolverAccount ?? account),
        issuerAccount: addr(options.issuerAccount ?? account),
      },
    );
  }

  /**
   * The same sandbox seen as another sender: writes through the returned
   * client come from `account`, and both clients share one state.
   */
  as(account: Address): SandboxLacrewClient {
    const sender = addr(account);
    return new SandboxLacrewClient(this.state, {
      account: sender,
      resolverAccount: sender,
      issuerAccount: sender,
    });
  }

  // ——— state, time, raw calls ———

  /** The current world. Treat as read-only: writes go through the client. */
  get world(): World {
    return this.state.world;
  }

  /** Unix seconds on the sandbox clock. */
  now(): number {
    return this.state.clock.now();
  }

  /** The whole sandbox as JSON, for `SandboxLacrewClient.create({ snapshot })`. */
  snapshot(): SandboxSnapshot {
    return { version: 1, txCount: this.state.txCount, world: serializeWorld(this.state.world) };
  }

  get addresses(): ChainAddresses {
    const a = this.state.world.addresses;
    return {
      // No chain: zero is the one id EIP-155 assigns to nothing.
      chainId: 0,
      orgRegistry: a.orgRegistry,
      treasury: a.treasury,
      escalationRouter: a.escalationRouter,
      governanceModule: a.governanceModule,
      spendCapPolicy: a.spendCapPolicy,
      mockUSDC: a.token,
      policyStack: a.policyStack,
      managerPolicyStack: a.managerPolicyStack,
      whitelistPolicy: a.whitelistPolicy,
      timeWindowPolicy: a.timeWindowPolicy,
      epochStreamer: a.epochStreamer,
      sessionRegistry: a.sessionRegistry,
      humanRoot: this.state.world.orgRegistry.root,
    };
  }

  /** Commit one kernel transaction as `sender`. */
  private commit<T>(sender: Address, fn: (ctx: Ctx) => T): { result: T; simTxId: string } {
    const at = this.state.clock.now();
    const out = transact(this.state.world, { sender, at: BigInt(at), env: abiEnv }, fn);
    this.state.world = out.world;
    this.state.txCount += 1;
    const id = simTxId(this.state.txCount);
    const iso = new Date(at * 1000).toISOString();
    for (const event of out.events) {
      const mapped = toProtocolEvent(event, iso, id);
      if (mapped) this.state.audit.push(mapped);
    }
    if (this.state.audit.length > AUDIT_RING_MAX) {
      this.state.audit.splice(0, this.state.audit.length - AUDIT_RING_MAX);
    }
    this.state.onCommit?.({
      simTxId: id,
      sender: addr(sender),
      at,
      events: out.events,
      snapshot: () => this.snapshot(),
    });
    return { result: out.result, simTxId: id };
  }

  /** Run a read at the current time; nothing it does is kept. */
  private read<T>(fn: (ctx: Ctx) => T, sender: Address = this.account): T {
    return transact(
      this.state.world,
      { sender, at: BigInt(this.state.clock.now()), env: abiEnv },
      fn,
    ).result;
  }

  /**
   * Run kernel functions directly as one transaction from `sender`: the way to
   * reach what the client has no method for (a constructor, a bootstrap
   * setter). Atomic like every other write, and named by its `simTxId`.
   */
  transact<T>(sender: Address, fn: (ctx: Ctx) => T): { result: T; simTxId: string; at: number } {
    const at = this.state.clock.now();
    return { ...this.commit(addr(sender), fn), at };
  }

  /**
   * Send calldata to a simulated contract by address, as a transaction.
   * `from` defaults to this client's account. A target that holds no
   * simulated contract accepts the call the way an address without code does.
   */
  sendTransaction(tx: { to: Address; data: Hex; from?: Address }): {
    simTxId: string;
    outcome: CallOutcome;
  } {
    const { result, simTxId: id } = this.commit(addr(tx.from ?? this.account), (ctx) =>
      callByAddress(ctx, tx.to, tx.data),
    );
    return { simTxId: id, outcome: result };
  }

  /** `eth_call` against a simulated contract: the decoded kernel result, nothing committed. */
  call(tx: { to: Address; data: Hex; from?: Address }): unknown {
    const outcome = this.read(
      (ctx) => callByAddress(ctx, tx.to, tx.data),
      addr(tx.from ?? this.account),
    );
    return outcome.kind === "contract" ? outcome.result : undefined;
  }

  /**
   * Add play money to the treasury: the token owner mints `amount`, approves
   * the treasury and deposits it, as one transaction. Grants no allowance.
   */
  async fund(amount: bigint): Promise<WriteRef> {
    const owner = this.state.world.token.owner;
    const { simTxId: id } = this.commit(owner, (ctx) => {
      token.mint(ctx, owner, amount);
      token.approve(ctx, ctx.world.addresses.treasury, amount);
      treasury.deposit(ctx, amount);
    });
    return { simTxId: id };
  }

  // ——— OrgRegistry ———

  async getOrgTree(): Promise<OrgNode[]> {
    return this.read((ctx) => this.readTree(ctx));
  }

  private readTree(ctx: Ctx): OrgNode[] {
    const nodes: OrgNode[] = [];
    const queue: Address[] = [ctx.world.orgRegistry.root];
    const seen = new Set<string>();
    while (queue.length) {
      const account = queue.shift()!;
      if (seen.has(account)) continue;
      seen.add(account);
      const node = orgRegistry.getNode(ctx, account);
      nodes.push({
        account: node.account,
        kind: KIND_FROM[node.kind] ?? "worker_agent",
        parent: node.parent === ZERO_ADDRESS ? null : node.parent,
        active: node.active,
      });
      queue.push(...orgRegistry.getChildren(ctx, account));
    }
    return nodes;
  }

  // ——— Treasury ———

  async getAllowances(node?: Address, asset?: string): Promise<Allowance[]> {
    const stack = resolveAssetStack(this.addresses, asset);
    return this.read((ctx) => {
      const tree = this.readTree(ctx);
      const targets = node ? tree.filter((n) => n.account === addr(node)) : tree;
      const epoch = Number(ctx.world.epochStreamer.currentEpoch);
      const out: Allowance[] = [];
      for (const n of targets) {
        const balance = ctx.world.treasury.allowanceBalance[n.account] ?? 0n;
        if (balance === 0n && n.kind === "human_root") continue;
        out.push({
          node: n.account,
          token: stack.token,
          balance,
          epoch,
          cap: policies.capOf(ctx, ctx.world.addresses.spendCapPolicy, n.account),
        });
      }
      return out;
    });
  }

  async getTreasuryBalances(): Promise<TreasuryBalance[]> {
    return this.read((ctx) =>
      listAssetStacks(this.addresses).map((stack) => ({
        symbol: stack.symbol,
        token: stack.token,
        decimals: stack.decimals,
        total: token.balanceOf(ctx, stack.treasury),
        liquid: treasury.liquidBalance(ctx),
        reserved: ctx.world.treasury.totalReserved,
      })),
    );
  }

  // ——— EscalationRouter ———

  private readIntent(ctx: Ctx, id: bigint): Intent {
    const row = escalationRouter.intents(ctx, id);
    return {
      id: id.toString(),
      agent: row.agent,
      target: row.target,
      value: row.value,
      data: row.data,
      awaitingApprover: row.awaitingApprover === ZERO_ADDRESS ? null : row.awaitingApprover,
      resolved: row.resolved,
      approved: row.resolved ? row.approved : null,
      verdict: row.resolved ? (row.approved ? "ALLOW" : "DENY") : "ESCALATE",
    };
  }

  async getPendingIntents(): Promise<Intent[]> {
    return this.read((ctx) => {
      const out: Intent[] = [];
      for (let id = 1n; id < ctx.world.escalationRouter.nextIntentId; id++) {
        const intent = this.readIntent(ctx, id);
        if (!intent.resolved) out.push(intent);
      }
      return out;
    });
  }

  async proposeIntent(input: {
    agent: Address;
    target: Address;
    value: bigint;
    data?: Hex;
    account?: Account | { address: Address };
  }): Promise<{ intentId: string; verdict: Verdict; simTxId: string }> {
    const sender = addr(input.account?.address ?? this.account);
    const { result, simTxId: id } = this.commit(sender, (ctx) =>
      escalationRouter.propose(ctx, input.agent, input.target, input.value, input.data ?? "0x"),
    );
    return {
      intentId: result.intentId.toString(),
      verdict: VERDICT_FROM[result.verdict] ?? "ESCALATE",
      simTxId: id,
    };
  }

  /**
   * Settle a pending intent as `approver`, or as the seat the intent awaits.
   * No key decides who may: the kernel refuses any sender but that seat.
   */
  async resolveIntent(
    intentId: string,
    approved: boolean,
    approver?: Address,
  ): Promise<ProtocolResolveResult & { simTxId: string }> {
    const id = BigInt(intentId);
    const waiting = approver ?? this.read((ctx) => this.readIntent(ctx, id)).awaitingApprover;
    const sender = addr(waiting ?? this.resolverAccount);
    const { simTxId: txId } = this.commit(sender, (ctx) =>
      escalationRouter.resolve(ctx, id, approved),
    );
    const intent = this.read((ctx) => this.readIntent(ctx, id));
    return {
      intent,
      escalated: !intent.resolved && intent.awaitingApprover !== null,
      simTxId: txId,
    };
  }

  async simulateResolveApproval(intentId: string): Promise<{ ok: boolean; reason?: string }> {
    const id = BigInt(intentId);
    try {
      const sender = this.read((ctx) => this.readIntent(ctx, id)).awaitingApprover;
      this.read((ctx) => escalationRouter.resolve(ctx, id, true), sender ?? this.resolverAccount);
      return { ok: true };
    } catch (err) {
      if (err instanceof SimRevert) return { ok: false, reason: err.errorName };
      throw err;
    }
  }

  async readNodeRateRecorder(node: Address, asset?: string): Promise<Address> {
    resolveAssetStack(this.addresses, asset);
    return this.state.world.escalationRouter.rateRecorderOf[addr(node)] ?? ZERO_ADDRESS;
  }

  // ——— Policy modules ———

  async checkPolicy(input: {
    agent: Address;
    target: Address;
    value: bigint;
    data?: Hex;
    policyModule?: Address;
  }): Promise<Verdict> {
    const module = input.policyModule ?? this.addresses.policyStack!;
    const verdict = this.read((ctx) =>
      policies.check(ctx, module, input.agent, input.target, input.value, input.data ?? "0x"),
    );
    return VERDICT_FROM[verdict] ?? "DENY";
  }

  async getNodePolicies(
    opts: { nodes?: Address[]; asset?: string } = {},
  ): Promise<NodePolicyStack[]> {
    resolveAssetStack(this.addresses, opts.asset);
    return this.read((ctx) => {
      const router = ctx.world.escalationRouter;
      const nodes = opts.nodes ?? this.readTree(ctx).map((n) => n.account);
      const out: NodePolicyStack[] = [];
      for (const node of nodes) {
        const bound = router.policyOf[addr(node)] ?? ZERO_ADDRESS;
        const policyModule = bound !== ZERO_ADDRESS ? bound : router.policy;
        const source = bound !== ZERO_ADDRESS ? ("node" as const) : ("default" as const);
        if (policyModule === ZERO_ADDRESS) {
          out.push({ node, policyModule, source, modules: [] });
          continue;
        }
        const info = this.describePolicyModule(ctx, policyModule, addr(node), 0);
        out.push({
          node,
          policyModule,
          source,
          modules: info.kind === "stack" ? (info.modules ?? []) : [info],
        });
      }
      return out;
    });
  }

  /** One module in the reported form for `node`; nested stacks recurse to a bounded depth. */
  private describePolicyModule(
    ctx: Ctx,
    address: Address,
    node: Address,
    depth: number,
  ): PolicyModuleInfo {
    const module = ctx.world.policies[address];
    if (!module) return { address, kind: "unknown" };
    switch (module.kind) {
      case "PolicyStack":
        return {
          address,
          kind: "stack",
          modules:
            depth < 3
              ? module.modules.map((m) => this.describePolicyModule(ctx, m, node, depth + 1))
              : [],
        };
      case "SpendCapPolicy":
        return {
          address,
          kind: "spend_cap",
          defaultCap: module.defaultCap.toString(),
          cap: policies.capOf(ctx, address, node).toString(),
          capIsExplicit: module.hasAgentCap[node] ?? false,
        };
      case "WhitelistPolicy":
        return {
          address,
          kind: "whitelist",
          allowedTargets: (Object.keys(module.allowed) as Address[]).filter(
            (target) => module.allowed[target],
          ),
        };
      case "RateLimitPolicy": {
        const window = module.windows[node] ?? { windowStart: 0n, count: 0n };
        return {
          address,
          kind: "rate_limit",
          maxActions: Number(module.maxActions),
          windowSeconds: Number(module.windowSeconds),
          windowStartSec: Number(window.windowStart),
          actionsUsed: Number(window.count),
        };
      }
      case "TimeWindowPolicy":
        return {
          address,
          kind: "time_window",
          startSecondOfDay: Number(module.startSecondOfDay),
          endSecondOfDay: Number(module.endSecondOfDay),
        };
    }
  }

  async capOf(agent: Address): Promise<bigint | undefined> {
    return this.read((ctx) => policies.capOf(ctx, ctx.world.addresses.spendCapPolicy, agent));
  }

  // ——— SessionRegistry ———

  async getSessions(agent?: Address): Promise<SessionKey[]> {
    return this.read((ctx) => {
      const agents = agent ? [addr(agent)] : this.readTree(ctx).map((n) => n.account);
      const nowSec = Number(ctx.now);
      const out: SessionKey[] = [];
      for (const a of agents) {
        for (const id of sessionRegistry.sessionsOf(ctx, a)) {
          const s = sessionRegistry.sessions(ctx, id);
          if (!s.exists) continue;
          const expiresAtSec = Number(s.expiresAt);
          const rl = sessionRegistry.rateLimits(ctx, id);
          const pinned = sessionRegistry.allowedTargetsOf(ctx, id);
          out.push({
            agent: a,
            keyId: id.toString(),
            keyAddress: s.key,
            expiresAt: expiresAtSec * 1000,
            scopes: sessionScopesFromMask(s.scopeMask),
            maxValue: s.maxValue.toString(),
            allowedTarget: s.allowedTarget,
            ...(pinned.length > 0 ? { allowedTargets: pinned } : {}),
            window:
              s.windowEnd === 0n
                ? undefined
                : { start: Number(s.windowStart), end: Number(s.windowEnd) },
            rate:
              rl.maxProposals === 0n
                ? undefined
                : { maxProposals: Number(rl.maxProposals), ratePeriod: Number(rl.ratePeriod) },
            revoked: s.revoked || expiresAtSec <= nowSec,
          });
        }
      }
      return out.sort((x, y) => y.expiresAt - x.expiresAt);
    });
  }

  async readKeyLimits(agent: Address, key: Address): Promise<SessionKeyLimits> {
    return this.read((ctx) => {
      const limits = sessionRegistry.keyLimits(ctx, agent, key);
      const base = {
        valid: limits.valid,
        maxValue: limits.maxValue,
        allowedTarget: limits.allowedTarget,
      };
      if (!limits.valid) return base;
      const id = ctx.world.sessionRegistry.activeKeySession[addr(agent)]?.[addr(key)] ?? 0n;
      const s = sessionRegistry.sessions(ctx, id);
      const rl = sessionRegistry.rateLimits(ctx, id);
      return {
        ...base,
        window:
          s.windowEnd === 0n
            ? undefined
            : { start: Number(s.windowStart), end: Number(s.windowEnd) },
        rate:
          rl.maxProposals === 0n
            ? undefined
            : { maxProposals: Number(rl.maxProposals), ratePeriod: Number(rl.ratePeriod) },
      };
    });
  }

  async issueSession(input: IssueSessionInput): Promise<{ sessionId: string; simTxId: string }> {
    const maxValue = input.maxValue ?? MAX_UINT256;
    const allowedTarget = input.allowedTarget ?? ZERO_ADDRESS;
    const targets =
      input.allowedTargets && input.allowedTargets.length > 0
        ? input.allowedTargets
        : addr(allowedTarget) === ZERO_ADDRESS
          ? []
          : [allowedTarget];
    const expiresAt = BigInt(input.expiresAtSec);
    // The same entry point the onchain client picks for the same input.
    const { result, simTxId: id } = this.commit(this.issuerAccount, (ctx) =>
      input.window || input.rate
        ? sessionRegistry.issueScopedTimed(
            ctx,
            input.agent,
            input.key,
            expiresAt,
            input.scopeMask,
            maxValue,
            targets,
            BigInt(input.window?.start ?? 0),
            BigInt(input.window?.end ?? 0),
            BigInt(input.rate?.maxProposals ?? 0),
            BigInt(input.rate?.ratePeriod ?? 0),
          )
        : targets.length > 1
          ? sessionRegistry.issueScoped(
              ctx,
              input.agent,
              input.key,
              expiresAt,
              input.scopeMask,
              maxValue,
              targets,
            )
          : sessionRegistry.issue(
              ctx,
              input.agent,
              input.key,
              expiresAt,
              input.scopeMask,
              maxValue,
              targets[0] ?? allowedTarget,
            ),
    );
    return { sessionId: result.toString(), simTxId: id };
  }

  async revokeSession(sessionId: string): Promise<{ simTxId: string }> {
    const { simTxId: id } = this.commit(this.issuerAccount, (ctx) =>
      sessionRegistry.revoke(ctx, BigInt(sessionId)),
    );
    return { simTxId: id };
  }

  async setIssuer(issuer: Address): Promise<{ simTxId: string }> {
    const { simTxId: id } = this.commit(this.account, (ctx) =>
      sessionRegistry.setIssuer(ctx, issuer),
    );
    return { simTxId: id };
  }

  async getIssuer(): Promise<Address> {
    return this.state.world.sessionRegistry.issuer;
  }

  // ——— EpochStreamer ———

  async getCurrentEpoch(asset?: string): Promise<number> {
    resolveAssetStack(this.addresses, asset);
    return Number(this.state.world.epochStreamer.currentEpoch);
  }

  async getGrants(asset?: string): Promise<EpochGrant[]> {
    resolveAssetStack(this.addresses, asset);
    const state = this.state.world.epochStreamer;
    return state.recipients.map((account) => ({
      account,
      amount: (state.grantAmount[account] ?? 0n).toString(),
    }));
  }

  async runEpoch(asset?: string): Promise<{ epoch: number; simTxId: string }> {
    resolveAssetStack(this.addresses, asset);
    const { result, simTxId: id } = this.commit(this.account, (ctx) =>
      epochStreamer.runNextEpoch(ctx),
    );
    return { epoch: Number(result), simTxId: id };
  }

  // ——— GovernanceModule ———

  private readProposal(ctx: Ctx, id: bigint): GovernanceProposal {
    const p = governance.proposals(ctx, id);
    return {
      id: id.toString(),
      proposer: p.proposer,
      tier: TIER_FROM[p.tier] ?? "low",
      target: p.target,
      actionHash: p.actionHash,
      data: p.data,
      yesVotes: Number(p.yesVotes),
      noVotes: Number(p.noVotes),
      yesHumanVotes: Number(p.yesHumanVotes),
      deadline: Number(p.deadline),
      eta: Number(p.eta),
      state: STATE_FROM[p.state] ?? "active",
    };
  }

  async getProposals(): Promise<GovernanceProposal[]> {
    return this.read((ctx) => {
      const out: GovernanceProposal[] = [];
      for (let id = 1n; id < ctx.world.governance.nextProposalId; id++) {
        out.push(this.readProposal(ctx, id));
      }
      return out;
    });
  }

  async getProposal(proposalId: string): Promise<GovernanceProposal> {
    return this.read((ctx) => this.readProposal(ctx, BigInt(proposalId)));
  }

  async readGovernanceConfig(): Promise<GovernanceConfig> {
    return this.read((ctx) => {
      const g = ctx.world.governance;
      return {
        quorumYes: g.quorumYes.toString(),
        quorumHumanYes: g.quorumHumanYes.toString(),
        humanRoot: g.humanRoot,
        totalVotingPower: g.totalVotingPower.toString(),
        totalHumanVotingPower: g.totalHumanVotingPower.toString(),
        humanSeatCount: g.humanSeatCount.toString(),
        effectiveQuorumYes: governance.effectiveQuorumYes(ctx).toString(),
        effectiveQuorumHumanYes: governance.effectiveQuorumHumanYes(ctx).toString(),
        votingPeriod: Number(g.votingPeriod),
        highTierTimelock: Number(g.highTierTimelock),
        unanimityFastPath: g.unanimityFastPath,
      };
    });
  }

  async readGovernanceSeat(voter: Address): Promise<GovernanceSeat> {
    const g = this.state.world.governance;
    const key = addr(voter);
    return {
      voter,
      power: (g.votingPower[key] ?? 0n).toString(),
      role: SEAT_ROLE_FROM[g.seatRole[key] ?? 0] ?? "none",
    };
  }

  /** Every address ever given voting power, heaviest first; revoked seats only on request. */
  async readGovernanceSeats(opts: { includeRevoked?: boolean } = {}): Promise<GovernanceSeat[]> {
    const voters = Object.keys(this.state.world.governance.votingPower) as Address[];
    const seats = await Promise.all(voters.map((voter) => this.readGovernanceSeat(voter)));
    const active = opts.includeRevoked ? seats : seats.filter((s) => s.power !== "0");
    return active.sort((a, b) => {
      const d = BigInt(b.power) - BigInt(a.power);
      return d > 0n ? 1 : d < 0n ? -1 : a.voter.localeCompare(b.voter);
    });
  }

  async readHasVoted(proposalId: string, voter: Address): Promise<boolean> {
    return this.read((ctx) => governance.hasVoted(ctx, BigInt(proposalId), voter));
  }

  async proposeGovernance(input: {
    tier: GovernanceTier;
    target: Address;
    data: Hex;
  }): Promise<{ proposalId: string; simTxId: string }> {
    const { result, simTxId: id } = this.commit(this.account, (ctx) =>
      governance.propose(ctx, TIER_TO[input.tier], input.target, input.data),
    );
    return { proposalId: result.toString(), simTxId: id };
  }

  /** Cast this client's vote; `useResolver` votes as the resolver account instead. */
  async voteGovernance(
    proposalId: string,
    support: boolean,
    opts?: { useResolver?: boolean },
  ): Promise<{ simTxId: string }> {
    const sender = opts?.useResolver ? this.resolverAccount : this.account;
    const { simTxId: id } = this.commit(sender, (ctx) =>
      governance.vote(ctx, BigInt(proposalId), support),
    );
    return { simTxId: id };
  }

  async vetoGovernance(proposalId: string): Promise<{ simTxId: string }> {
    const { simTxId: id } = this.commit(this.account, (ctx) =>
      governance.veto(ctx, BigInt(proposalId)),
    );
    return { simTxId: id };
  }

  async executeGovernance(proposalId: string): Promise<{ simTxId: string }> {
    const { simTxId: id } = this.commit(this.account, (ctx) =>
      governance.execute(ctx, BigInt(proposalId)),
    );
    return { simTxId: id };
  }

  // ——— Governance actions: the same calldata the onchain client encodes ———

  async proposeHire(input: {
    label: string;
    kind?: OrgNode["kind"];
    parent?: Address;
    account?: Address;
    tier?: GovernanceTier;
  }): Promise<{ proposalId: string; account: Address; simTxId: string }> {
    const kind = input.kind ?? "worker_agent";
    const parent = input.parent ?? this.addresses.humanRoot ?? ZERO_ADDRESS;
    const account =
      input.account ??
      (`0x${keccak256(toBytes(`lacrew.hire:${input.label}`)).slice(26)}` as Address);
    const data = encodeFunctionData({
      abi: orgRegistryAbi,
      functionName: "addNode",
      args: [account, KIND_TO[kind], parent],
    });
    const result = await this.proposeGovernance({
      tier: input.tier ?? "low",
      target: this.addresses.orgRegistry,
      data,
    });
    return { ...result, account };
  }

  async proposeFire(input: {
    account: Address;
    tier?: GovernanceTier;
  }): Promise<{ proposalId: string; account: Address; simTxId: string }> {
    const data = encodeFunctionData({
      abi: orgRegistryAbi,
      functionName: "removeNode",
      args: [input.account],
    });
    const result = await this.proposeGovernance({
      tier: input.tier ?? "low",
      target: this.addresses.orgRegistry,
      data,
    });
    return { ...result, account: input.account };
  }

  async proposeSetActive(input: {
    account: Address;
    active: boolean;
    tier?: GovernanceTier;
  }): Promise<{ proposalId: string; account: Address; simTxId: string }> {
    const data = encodeFunctionData({
      abi: orgRegistryAbi,
      functionName: "setActive",
      args: [input.account, input.active],
    });
    const result = await this.proposeGovernance({
      tier: input.tier ?? "low",
      target: this.addresses.orgRegistry,
      data,
    });
    return { ...result, account: input.account };
  }

  async proposeReparent(input: {
    account: Address;
    newParent: Address;
    tier?: GovernanceTier;
  }): Promise<{ proposalId: string; account: Address; simTxId: string }> {
    const data = encodeFunctionData({
      abi: orgRegistryAbi,
      functionName: "reparent",
      args: [input.account, input.newParent],
    });
    const result = await this.proposeGovernance({
      tier: input.tier ?? "low",
      target: this.addresses.orgRegistry,
      data,
    });
    return { ...result, account: input.account };
  }

  async proposeSetGrant(input: {
    account: Address;
    amount: bigint;
    tier?: GovernanceTier;
    asset?: string;
  }): Promise<{ proposalId: string; account: Address; simTxId: string }> {
    const target = resolveAssetStack(this.addresses, input.asset).epochStreamer;
    const data = encodeFunctionData({
      abi: epochStreamerAbi,
      functionName: "setGrant",
      args: [input.account, input.amount],
    });
    const result = await this.proposeGovernance({ tier: input.tier ?? "high", target, data });
    return { ...result, account: input.account };
  }

  async proposeSetGrants(input: {
    entries: Array<{ account: Address; amount: bigint }>;
    tier?: GovernanceTier;
    asset?: string;
  }): Promise<{ proposalId: string; count: number; simTxId: string }> {
    const target = resolveAssetStack(this.addresses, input.asset).epochStreamer;
    if (input.entries.length === 0) throw new Error("no grants to set");
    const data = encodeFunctionData({
      abi: epochStreamerAbi,
      functionName: "setGrants",
      args: [input.entries.map((e) => e.account), input.entries.map((e) => e.amount)],
    });
    const result = await this.proposeGovernance({ tier: input.tier ?? "high", target, data });
    return { ...result, count: input.entries.length };
  }

  async proposeSetNodePolicy(input: {
    node: Address;
    policyModule: Address;
    tier?: GovernanceTier;
    asset?: string;
  }): Promise<{ proposalId: string; node: Address; simTxId: string }> {
    const data = encodeFunctionData({
      abi: escalationRouterAbi,
      functionName: "setNodePolicy",
      args: [input.node, input.policyModule],
    });
    const result = await this.proposeGovernance({
      tier: input.tier ?? "high",
      target: resolveAssetStack(this.addresses, input.asset).escalationRouter,
      data,
    });
    return { ...result, node: input.node };
  }

  async proposeSetNodeRateRecorder(input: {
    node: Address;
    rateRecorder: Address;
    tier?: GovernanceTier;
    asset?: string;
  }): Promise<{ proposalId: string; node: Address; simTxId: string }> {
    const data = encodeFunctionData({
      abi: escalationRouterAbi,
      functionName: "setNodeRateRecorder",
      args: [input.node, input.rateRecorder],
    });
    const result = await this.proposeGovernance({
      tier: input.tier ?? "high",
      target: resolveAssetStack(this.addresses, input.asset).escalationRouter,
      data,
    });
    return { ...result, node: input.node };
  }

  async proposeSetWhitelist(input: {
    target: Address;
    allowed: boolean;
    tier?: GovernanceTier;
    asset?: string;
  }): Promise<{ proposalId: string; target: Address; simTxId: string }> {
    const module = resolveAssetStack(this.addresses, input.asset).whitelistPolicy!;
    const data = encodeFunctionData({
      abi: whitelistPolicyAbi,
      functionName: "setAllowed",
      args: [input.target, input.allowed],
    });
    const result = await this.proposeGovernance({
      tier: input.tier ?? "high",
      target: module,
      data,
    });
    return { ...result, target: input.target };
  }

  async proposeSetAgentCap(input: {
    agent: Address;
    cap: bigint;
    tier?: GovernanceTier;
    asset?: string;
  }): Promise<{ proposalId: string; agent: Address; simTxId: string }> {
    const module = resolveAssetStack(this.addresses, input.asset).spendCapPolicy!;
    const data = encodeFunctionData({
      abi: spendCapPolicyAbi,
      functionName: "setAgentCap",
      args: [input.agent, input.cap],
    });
    const result = await this.proposeGovernance({
      tier: input.tier ?? "high",
      target: module,
      data,
    });
    return { ...result, agent: input.agent };
  }

  async proposeAdmitHuman(input: {
    account: Address;
    power: bigint;
  }): Promise<{ proposalId: string; account: Address; simTxId: string }> {
    const data = encodeFunctionData({
      abi: governanceModuleAbi,
      functionName: "admitHuman",
      args: [input.account, input.power],
    });
    const result = await this.proposeGovernance({
      tier: "high",
      target: this.addresses.governanceModule,
      data,
    });
    return { ...result, account: input.account };
  }

  async proposeRemoveHuman(input: {
    account: Address;
  }): Promise<{ proposalId: string; account: Address; simTxId: string }> {
    const data = encodeFunctionData({
      abi: governanceModuleAbi,
      functionName: "removeHuman",
      args: [input.account],
    });
    const result = await this.proposeGovernance({
      tier: "high",
      target: this.addresses.governanceModule,
      data,
    });
    return { ...result, account: input.account };
  }

  // ——— Policy module deployment ———
  //
  // A module's parameters are constructor-immutable, so changing a node's rate
  // limit or window means deploying a new module and rebinding. Deployment is
  // inert here as on a chain: nothing is constrained until governance binds it.

  /** Deploy a RateLimitPolicy and lock its recorder to the router. */
  async deployRateLimitPolicy(input: {
    maxActions: number;
    windowSeconds: number;
  }): Promise<{ address: Address; simTxId: string }> {
    const { result, simTxId: id } = this.commit(this.account, (ctx) => {
      const address = allocateAddress(ctx);
      policies.deployRateLimitPolicy(
        ctx,
        address,
        BigInt(input.maxActions),
        BigInt(input.windowSeconds),
      );
      policies.setRecorder(ctx, address, ctx.world.addresses.escalationRouter);
      return address;
    });
    return { address: result, simTxId: id };
  }

  async deployTimeWindowPolicy(input: {
    startSecondOfDay: number;
    endSecondOfDay: number;
  }): Promise<{ address: Address; simTxId: string }> {
    const { result, simTxId: id } = this.commit(this.account, (ctx) => {
      const address = allocateAddress(ctx);
      policies.deployTimeWindowPolicy(
        ctx,
        address,
        BigInt(input.startSecondOfDay),
        BigInt(input.endSecondOfDay),
      );
      return address;
    });
    return { address: result, simTxId: id };
  }

  async deployPolicyStack(modules: Address[]): Promise<{ address: Address; simTxId: string }> {
    if (modules.length === 0) throw new Error("a PolicyStack needs at least one module");
    const { result, simTxId: id } = this.commit(this.account, (ctx) => {
      const address = allocateAddress(ctx);
      policies.deployPolicyStack(ctx, address, modules);
      return address;
    });
    return { address: result, simTxId: id };
  }

  // ——— What only a chain can do ———

  async quoteListing(_catalogId: string): Promise<never> {
    throw new SandboxNeedsChainError("Marketplace payments");
  }

  async getListing(_catalogId: string): Promise<never> {
    throw new SandboxNeedsChainError("Marketplace payments");
  }

  async hasPurchased(_catalogId: string, _buyer: Address): Promise<never> {
    throw new SandboxNeedsChainError("Marketplace payments");
  }

  async registerListing(_input: { catalogId: string; price: bigint }): Promise<never> {
    throw new SandboxNeedsChainError("Marketplace payments");
  }

  async purchaseListing(_input: { catalogId: string; maxPrice?: bigint }): Promise<never> {
    throw new SandboxNeedsChainError("Marketplace payments");
  }

  async proposeMarketplacePurchase(_input: { agent: Address; catalogId: string }): Promise<never> {
    throw new SandboxNeedsChainError("Marketplace payments");
  }

  async marketplaceEarnings(_payee: Address): Promise<never> {
    throw new SandboxNeedsChainError("Marketplace payments");
  }

  async withdrawMarketplaceEarnings(): Promise<never> {
    throw new SandboxNeedsChainError("Marketplace payments");
  }

  // ——— Audit ———

  /** Events of the transactions this client committed, oldest first, bounded. */
  async getAuditTrail(): Promise<ProtocolEvent[]> {
    return [...this.state.audit];
  }
}

export function createSandboxClient(options: SandboxClientOptions): SandboxLacrewClient {
  return SandboxLacrewClient.create(options);
}
