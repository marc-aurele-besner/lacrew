/**
 * Calldata in, kernel call out.
 *
 * The kernel has no ABI library, so this is where a `(target, data)` pair —
 * the same bytes the onchain client encodes — is decoded against the real
 * ABIs and routed to the kernel function of that name. It backs every
 * `target.call(data)` the contracts make (a governance `execute`, the router's
 * post-spend call) and every transaction sent to the sandbox by address.
 */

import {
  decodeFunctionData,
  encodeAbiParameters,
  keccak256,
  type Abi,
  type Hex as ViemHex,
} from "viem";
import {
  epochStreamerAbi,
  escalationRouterAbi,
  governanceModuleAbi,
  mockUsdcAbi,
  orgRegistryAbi,
  policyStackAbi,
  rateLimitPolicyAbi,
  sessionRegistryAbi,
  spendCapPolicyAbi,
  timeWindowPolicyAbi,
  treasuryAbi,
  whitelistPolicyAbi,
} from "@lacrew/core";

import {
  EVM_REVERT,
  SimRevert,
  ZERO_ADDRESS,
  addr,
  epochStreamer,
  escalationRouter,
  governance,
  orgRegistry,
  policies,
  sessionRegistry,
  token,
  treasury,
  type Address,
  type CallContext,
  type Ctx,
  type Hex,
  type KernelEnv,
  type World,
} from "./kernel/index.js";

/**
 * Raised for something the sandbox does not model because it only means
 * anything on a chain: marketplace settlement, x402 payment authorisations,
 * the test-token faucet. Not a revert — the contracts did not refuse it.
 */
export class SandboxNeedsChainError extends Error {
  readonly code = "needs_chain";
  constructor(what: string) {
    super(`${what} needs a chain: the sandbox simulates the org's rules, not external settlement`);
    this.name = "SandboxNeedsChainError";
  }
}

// Decoded arguments arrive as an untyped tuple; each handler knows its own ABI.
type Args = readonly any[];
type Handler = (ctx: Ctx, args: Args, self: Address) => unknown;
type HandlerTable = Record<string, Handler>;

const big = (value: unknown): bigint => BigInt(value as bigint | number);

/**
 * An enum argument. Solidity's ABI decoder rejects a value past the last
 * member before the function body runs, with no error data.
 */
function enumValue(value: unknown, members: number): number {
  const n = Number(value);
  if (n >= members) throw new SimRevert(EVM_REVERT);
  return n;
}

const needsChain =
  (what: string): Handler =>
  () => {
    throw new SandboxNeedsChainError(what);
  };

const ORG_REGISTRY: HandlerTable = {
  root: (ctx) => ctx.world.orgRegistry.root,
  governor: (ctx) => ctx.world.orgRegistry.governor,
  getNode: (ctx, [account]) => orgRegistry.getNode(ctx, account),
  getChildren: (ctx, [parent]) => orgRegistry.getChildren(ctx, parent),
  setGovernor: (ctx, [governor]) => orgRegistry.setGovernor(ctx, governor),
  addNode: (ctx, [account, kind, parent]) =>
    orgRegistry.addNode(ctx, account, enumValue(kind, 3), parent),
  setActive: (ctx, [account, active]) => orgRegistry.setActive(ctx, account, active),
  removeNode: (ctx, [account]) => orgRegistry.removeNode(ctx, account),
  reparent: (ctx, [account, newParent]) => orgRegistry.reparent(ctx, account, newParent),
};

const TREASURY: HandlerTable = {
  totalReserved: (ctx) => ctx.world.treasury.totalReserved,
  allowanceBalance: (ctx, [node]) => ctx.world.treasury.allowanceBalance[addr(node)] ?? 0n,
  liquidBalance: (ctx) => treasury.liquidBalance(ctx),
  token: (ctx) => ctx.world.treasury.token,
  spender: (ctx) => ctx.world.treasury.spender,
  governor: (ctx) => ctx.world.treasury.governor,
  streamer: (ctx) => ctx.world.treasury.streamer,
  deployer: (ctx) => ctx.world.treasury.deployer,
  setGovernor: (ctx, [governor]) => treasury.setGovernor(ctx, governor),
  setStreamer: (ctx, [streamer]) => treasury.setStreamer(ctx, streamer),
  setSpender: (ctx, [spender]) => treasury.setSpender(ctx, spender),
  deposit: (ctx, [amount]) => treasury.deposit(ctx, big(amount)),
  streamAllowance: (ctx, [node, amount, epoch]) =>
    treasury.streamAllowance(ctx, node, big(amount), big(epoch)),
  // Two overloads share the name; the argument count tells them apart.
  spendAllowance: (ctx, [node, amount, to]) => treasury.spendAllowance(ctx, node, big(amount), to),
};

const ESCALATION_ROUTER: HandlerTable = {
  nextIntentId: (ctx) => ctx.world.escalationRouter.nextIntentId,
  intents: (ctx, [id]) => escalationRouter.intents(ctx, big(id)),
  policy: (ctx) => ctx.world.escalationRouter.policy,
  policyOf: (ctx, [node]) => ctx.world.escalationRouter.policyOf[addr(node)] ?? ZERO_ADDRESS,
  rateRecorderOf: (ctx, [node]) =>
    ctx.world.escalationRouter.rateRecorderOf[addr(node)] ?? ZERO_ADDRESS,
  governor: (ctx) => ctx.world.escalationRouter.governor,
  setGovernor: (ctx, [governor]) => escalationRouter.setGovernor(ctx, governor),
  setTreasury: (ctx, [t]) => escalationRouter.setTreasury(ctx, t),
  setRateRecorder: (ctx, [r]) => escalationRouter.setRateRecorder(ctx, r),
  setSessionRegistry: (ctx, [s]) => escalationRouter.setSessionRegistry(ctx, s),
  setNodePolicy: (ctx, [node, module]) => escalationRouter.setNodePolicy(ctx, node, module),
  setNodeRateRecorder: (ctx, [node, recorder]) =>
    escalationRouter.setNodeRateRecorder(ctx, node, recorder),
  propose: (ctx, [agent, target, value, data]) =>
    escalationRouter.propose(ctx, agent, target, big(value), data),
  resolve: (ctx, [id, approved]) => escalationRouter.resolve(ctx, big(id), approved),
};

const SESSION_REGISTRY: HandlerTable = {
  issuer: (ctx) => ctx.world.sessionRegistry.issuer,
  humanRoot: (ctx) => ctx.world.sessionRegistry.humanRoot,
  maxIssuerTtl: (ctx) => ctx.world.sessionRegistry.maxIssuerTtl,
  sessions: (ctx, [id]) => sessionRegistry.sessions(ctx, big(id)),
  rateLimits: (ctx, [id]) => sessionRegistry.rateLimits(ctx, big(id)),
  sessionsOf: (ctx, [agent]) => sessionRegistry.sessionsOf(ctx, agent),
  allowedTargetsOf: (ctx, [id]) => sessionRegistry.allowedTargetsOf(ctx, big(id)),
  isValid: (ctx, [id]) => sessionRegistry.isValid(ctx, big(id)),
  isKeyValid: (ctx, [agent, key]) => sessionRegistry.isKeyValid(ctx, agent, key),
  keyLimits: (ctx, [agent, key]) => sessionRegistry.keyLimits(ctx, agent, key),
  withinTimeWindow: (ctx, [agent, key]) => sessionRegistry.withinTimeWindow(ctx, agent, key),
  isTargetAllowed: (ctx, [agent, key, target]) =>
    sessionRegistry.isTargetAllowed(ctx, agent, key, target),
  setIssuer: (ctx, [issuer]) => sessionRegistry.setIssuer(ctx, issuer),
  setMaxIssuerTtl: (ctx, [ttl]) => sessionRegistry.setMaxIssuerTtl(ctx, big(ttl)),
  setEscalationRouter: (ctx, [router]) => sessionRegistry.setEscalationRouter(ctx, router),
  issue: (ctx, [agent, key, expiresAt, mask, maxValue, target]) =>
    sessionRegistry.issue(ctx, agent, key, big(expiresAt), big(mask), big(maxValue), target),
  issueScoped: (ctx, [agent, key, expiresAt, mask, maxValue, targets]) =>
    sessionRegistry.issueScoped(ctx, agent, key, big(expiresAt), big(mask), big(maxValue), [
      ...targets,
    ]),
  issueScopedTimed: (ctx, [agent, key, expiresAt, mask, maxValue, targets, ws, we, mp, rp]) =>
    sessionRegistry.issueScopedTimed(
      ctx,
      agent,
      key,
      big(expiresAt),
      big(mask),
      big(maxValue),
      [...targets],
      big(ws),
      big(we),
      big(mp),
      big(rp),
    ),
  revoke: (ctx, [id]) => sessionRegistry.revoke(ctx, big(id)),
  recordProposal: (ctx, [agent, key]) => sessionRegistry.recordProposal(ctx, agent, key),
};

const EPOCH_STREAMER: HandlerTable = {
  currentEpoch: (ctx) => ctx.world.epochStreamer.currentEpoch,
  operator: (ctx) => ctx.world.epochStreamer.operator,
  governor: (ctx) => ctx.world.epochStreamer.governor,
  recipients: (ctx) => epochStreamer.recipients(ctx),
  grantAmount: (ctx, [node]) => epochStreamer.grantAmount(ctx, node),
  setOperator: (ctx, [operator]) => epochStreamer.setOperator(ctx, operator),
  setGovernor: (ctx, [governor]) => epochStreamer.setGovernor(ctx, governor),
  setGrant: (ctx, [node, amount]) => epochStreamer.setGrant(ctx, node, big(amount)),
  setGrants: (ctx, [nodes, amounts]) =>
    epochStreamer.setGrants(ctx, [...nodes], [...amounts].map(big)),
  runNextEpoch: (ctx) => epochStreamer.runNextEpoch(ctx),
  runEpoch: (ctx, [epoch]) => epochStreamer.runEpoch(ctx, big(epoch)),
};

const GOVERNANCE: HandlerTable = {
  nextProposalId: (ctx) => ctx.world.governance.nextProposalId,
  proposals: (ctx, [id]) => governance.proposals(ctx, big(id)),
  noHumanVotes: (ctx, [id]) => governance.noHumanVotes(ctx, big(id)),
  hasVoted: (ctx, [id, voter]) => governance.hasVoted(ctx, big(id), voter),
  votingPower: (ctx, [voter]) => ctx.world.governance.votingPower[addr(voter)] ?? 0n,
  seatRole: (ctx, [voter]) => ctx.world.governance.seatRole[addr(voter)] ?? 0,
  effectiveQuorumYes: (ctx) => governance.effectiveQuorumYes(ctx),
  effectiveQuorumHumanYes: (ctx) => governance.effectiveQuorumHumanYes(ctx),
  setVotingPower: (ctx, [voter, power, role]) =>
    governance.setVotingPower(ctx, voter, big(power), enumValue(role, 3)),
  admitHuman: (ctx, [human, power]) => governance.admitHuman(ctx, human, big(power)),
  removeHuman: (ctx, [human]) => governance.removeHuman(ctx, human),
  setQuorumYes: (ctx, [q]) => governance.setQuorumYes(ctx, big(q)),
  setQuorumHumanYes: (ctx, [q]) => governance.setQuorumHumanYes(ctx, big(q)),
  setTiming: (ctx, [period, timelock]) => governance.setTiming(ctx, big(period), big(timelock)),
  setUnanimityFastPath: (ctx, [enabled]) => governance.setUnanimityFastPath(ctx, enabled),
  propose: (ctx, [tier, target, data]) => governance.propose(ctx, enumValue(tier, 2), target, data),
  vote: (ctx, [id, support]) => governance.vote(ctx, big(id), support),
  veto: (ctx, [id]) => governance.veto(ctx, big(id)),
  execute: (ctx, [id]) => governance.execute(ctx, big(id)),
};

const TOKEN: HandlerTable = {
  balanceOf: (ctx, [account]) => token.balanceOf(ctx, account),
  allowance: (ctx, [owner, spender]) => token.allowance(ctx, owner, spender),
  totalSupply: (ctx) => ctx.world.token.totalSupply,
  decimals: () => 6,
  symbol: () => "mUSDC",
  name: () => "Mock USDC",
  owner: (ctx) => ctx.world.token.owner,
  minters: (ctx, [account]) => ctx.world.token.minters[addr(account)] ?? false,
  setMinter: (ctx, [account, allowed]) => token.setMinter(ctx, account, allowed),
  mint: (ctx, [to, amount]) => token.mint(ctx, to, big(amount)),
  transfer: (ctx, [to, value]) => token.transfer(ctx, to, big(value)),
  approve: (ctx, [spender, value]) => token.approve(ctx, spender, big(value)),
  transferFrom: (ctx, [from, to, value]) => token.transferFrom(ctx, from, to, big(value)),
  faucet: needsChain("The test-token faucet"),
  transferWithAuthorization: needsChain("x402 settlement (transferWithAuthorization)"),
  cancelAuthorization: needsChain("x402 settlement (cancelAuthorization)"),
};

/** Policy modules are many-instance: the callee's own address names which one. */
const POLICY_COMMON: HandlerTable = {
  check: (ctx, [agent, target, value, data], self) =>
    policies.check(ctx, self, agent, target, big(value), data),
};

const POLICY: Record<policies.PolicyModuleState["kind"], { abi: Abi; handlers: HandlerTable }> = {
  PolicyStack: {
    abi: policyStackAbi as Abi,
    handlers: {
      ...POLICY_COMMON,
      moduleCount: (ctx, _a, self) =>
        BigInt((ctx.world.policies[self] as policies.PolicyStackState).modules.length),
      modules: (ctx, [i], self) => {
        const member = (ctx.world.policies[self] as policies.PolicyStackState).modules[Number(i)];
        if (member === undefined) throw new SimRevert(EVM_REVERT);
        return member;
      },
    },
  },
  SpendCapPolicy: {
    abi: spendCapPolicyAbi as Abi,
    handlers: {
      ...POLICY_COMMON,
      capOf: (ctx, [agent], self) => policies.capOf(ctx, self, agent),
      setGovernor: (ctx, [governor], self) => policies.setGovernor(ctx, self, governor),
      setAgentCap: (ctx, [agent, cap], self) => policies.setAgentCap(ctx, self, agent, big(cap)),
    },
  },
  WhitelistPolicy: {
    abi: whitelistPolicyAbi as Abi,
    handlers: {
      ...POLICY_COMMON,
      allowed: (ctx, [target], self) =>
        (ctx.world.policies[self] as policies.WhitelistPolicyState).allowed[addr(target)] ?? false,
      setGovernor: (ctx, [governor], self) => policies.setGovernor(ctx, self, governor),
      setAllowed: (ctx, [target, isAllowed], self) =>
        policies.setAllowed(ctx, self, target, isAllowed),
    },
  },
  RateLimitPolicy: {
    abi: rateLimitPolicyAbi as Abi,
    handlers: {
      ...POLICY_COMMON,
      setRecorder: (ctx, [recorder], self) => policies.setRecorder(ctx, self, recorder),
      record: (ctx, [agent], self) => policies.record(ctx, self, agent),
    },
  },
  TimeWindowPolicy: { abi: timeWindowPolicyAbi as Abi, handlers: { ...POLICY_COMMON } },
};

/** The contract living at `target`, or null for an address that holds none. */
function contractAt(
  world: World,
  target: Address,
): { name: string; abi: Abi; handlers: HandlerTable } | null {
  if (target === ZERO_ADDRESS) return null;
  const a = world.addresses;
  if (target === a.orgRegistry) {
    return { name: "OrgRegistry", abi: orgRegistryAbi as Abi, handlers: ORG_REGISTRY };
  }
  if (target === a.treasury)
    return { name: "Treasury", abi: treasuryAbi as Abi, handlers: TREASURY };
  if (target === a.escalationRouter) {
    return {
      name: "EscalationRouter",
      abi: escalationRouterAbi as Abi,
      handlers: ESCALATION_ROUTER,
    };
  }
  if (target === a.sessionRegistry) {
    return { name: "SessionRegistry", abi: sessionRegistryAbi as Abi, handlers: SESSION_REGISTRY };
  }
  if (target === a.epochStreamer) {
    return { name: "EpochStreamer", abi: epochStreamerAbi as Abi, handlers: EPOCH_STREAMER };
  }
  if (target === a.governanceModule) {
    return { name: "GovernanceModule", abi: governanceModuleAbi as Abi, handlers: GOVERNANCE };
  }
  if (target === a.token) return { name: "MockUSDC", abi: mockUsdcAbi as Abi, handlers: TOKEN };
  const module = world.policies[target];
  if (module) return { name: module.kind, ...POLICY[module.kind] };
  return null;
}

/** What a call by address came to: the kernel's return value, or a note that nothing answered. */
export type CallOutcome =
  | { kind: "contract"; contract: string; functionName: string; result: unknown }
  | { kind: "external" };

/**
 * `target.call(data)` as `ctx.sender`. A target that holds no simulated
 * contract is an address without code: the call succeeds, does nothing, and is
 * recorded as an `ExternalCall` event. A contract that has no function for
 * the selector reverts with empty data, as the EVM does.
 */
export function callByAddress(ctx: Ctx, target_: Address, data: Hex): CallOutcome {
  const target = addr(target_);
  const contract = contractAt(ctx.world, target);
  if (!contract) {
    ctx.events.push({
      address: target,
      contract: "External",
      name: "ExternalCall",
      args: { from: ctx.sender, target, data },
    });
    return { kind: "external" };
  }
  let decoded: { functionName: string; args?: Args };
  try {
    decoded = decodeFunctionData({ abi: contract.abi, data: data as ViemHex }) as {
      functionName: string;
      args?: Args;
    };
  } catch {
    throw new SimRevert(EVM_REVERT);
  }
  const handler = contract.handlers[decoded.functionName];
  if (!handler) {
    // In the ABI but not modelled: say so by name instead of guessing a result.
    throw new SimRevert("NotSimulated", {
      contract: contract.name,
      functionName: decoded.functionName,
    });
  }
  const result = handler(ctx, decoded.args ?? [], target);
  return { kind: "contract", contract: contract.name, functionName: decoded.functionName, result };
}

/** The env a sandbox runs the kernel with: real calldata, real action hashes. */
export const abiEnv: KernelEnv = {
  dispatch(ctx: CallContext, target: Address, data: Hex): void {
    callByAddress(ctx as Ctx, target, data);
  },
  actionHash(target: Address, data: Hex): Hex {
    return keccak256(
      encodeAbiParameters([{ type: "address" }, { type: "bytes" }], [target, data as ViemHex]),
    );
  },
};
