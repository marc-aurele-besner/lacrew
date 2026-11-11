/**
 * EscalationRouter: propose, escalate, resolve. Mirrors
 * `contracts/src/EscalationRouter.sol`.
 */

import { asSender, emit, externalCall } from "./frame.js";
import * as orgRegistry from "./orgRegistry.js";
import * as policies from "./policies.js";
import { Verdict, type VerdictValue } from "./policies.js";
import * as sessionRegistry from "./sessionRegistry.js";
import * as treasury from "./treasury.js";
import {
  EVM_REVERT,
  MAX_UINT256,
  SimRevert,
  ZERO_ADDRESS,
  addr,
  byteLength,
  type Address,
  type Hex,
} from "./types.js";
import type { Ctx } from "./world.js";

const CONTRACT = "EscalationRouter";

export interface IntentState {
  agent: Address;
  target: Address;
  value: bigint;
  data: Hex;
  awaitingApprover: Address;
  resolved: boolean;
  approved: boolean;
}

export interface EscalationRouterState {
  orgRegistry: Address;
  /** Default policy stack when `policyOf[node]` is unset. */
  policy: Address;
  treasury: Address;
  rateRecorder: Address;
  sessionRegistry: Address;
  /** Holds bootstrap authority until `governor` is bound. */
  deployer: Address;
  governor: Address;
  nextIntentId: bigint;
  /** Keyed by intent id as a decimal string. */
  intents: Record<string, IntentState>;
  policyOf: Record<Address, Address>;
  rateRecorderOf: Record<Address, Address>;
}

export function blankEscalationRouter(): EscalationRouterState {
  return {
    orgRegistry: ZERO_ADDRESS,
    policy: ZERO_ADDRESS,
    treasury: ZERO_ADDRESS,
    rateRecorder: ZERO_ADDRESS,
    sessionRegistry: ZERO_ADDRESS,
    deployer: ZERO_ADDRESS,
    governor: ZERO_ADDRESS,
    nextIntentId: 1n,
    intents: {},
    policyOf: {},
    rateRecorderOf: {},
  };
}

export function deploy(ctx: Ctx, address: Address, orgRegistry_: Address, policy_: Address): void {
  if (addr(orgRegistry_) === ZERO_ADDRESS) throw new SimRevert("ZeroAddress");
  ctx.world.addresses.escalationRouter = address;
  ctx.world.escalationRouter = {
    ...blankEscalationRouter(),
    orgRegistry: addr(orgRegistry_),
    policy: addr(policy_),
    deployer: ctx.sender,
  };
}

export function setGovernor(ctx: Ctx, governor_: Address): void {
  const governor = addr(governor_);
  if (governor === ZERO_ADDRESS) throw new SimRevert("ZeroAddress");
  onlyGovernorOrBootstrap(ctx);
  ctx.world.escalationRouter.governor = governor;
  emit(ctx, ctx.world.addresses.escalationRouter, CONTRACT, "GovernorUpdated", { governor });
}

export function setTreasury(ctx: Ctx, treasury_: Address): void {
  onlyGovernorOrBootstrap(ctx);
  ctx.world.escalationRouter.treasury = addr(treasury_);
  emit(ctx, ctx.world.addresses.escalationRouter, CONTRACT, "TreasuryUpdated", {
    treasury: addr(treasury_),
  });
}

export function setRateRecorder(ctx: Ctx, rateRecorder_: Address): void {
  onlyGovernorOrBootstrap(ctx);
  ctx.world.escalationRouter.rateRecorder = addr(rateRecorder_);
  emit(ctx, ctx.world.addresses.escalationRouter, CONTRACT, "RateRecorderUpdated", {
    rateRecorder: addr(rateRecorder_),
  });
}

export function setSessionRegistry(ctx: Ctx, sessionRegistry_: Address): void {
  onlyGovernorOrBootstrap(ctx);
  ctx.world.escalationRouter.sessionRegistry = addr(sessionRegistry_);
  emit(ctx, ctx.world.addresses.escalationRouter, CONTRACT, "SessionRegistryUpdated", {
    sessionRegistry: addr(sessionRegistry_),
  });
}

export function setNodePolicy(ctx: Ctx, node_: Address, policyModule_: Address): void {
  const node = addr(node_);
  onlyGovernorOrBootstrap(ctx);
  if (node === ZERO_ADDRESS) throw new SimRevert("ZeroAddress");
  ctx.world.escalationRouter.policyOf[node] = addr(policyModule_);
  emit(ctx, ctx.world.addresses.escalationRouter, CONTRACT, "NodePolicyUpdated", {
    node,
    policyModule: addr(policyModule_),
  });
}

export function setNodeRateRecorder(ctx: Ctx, node_: Address, rateRecorder_: Address): void {
  const node = addr(node_);
  onlyGovernorOrBootstrap(ctx);
  if (node === ZERO_ADDRESS) throw new SimRevert("ZeroAddress");
  ctx.world.escalationRouter.rateRecorderOf[node] = addr(rateRecorder_);
  emit(ctx, ctx.world.addresses.escalationRouter, CONTRACT, "NodeRateRecorderUpdated", {
    node,
    rateRecorder: addr(rateRecorder_),
  });
}

/** ALLOW executes spend + call, ESCALATE creates an intent, DENY reverts. */
export function propose(
  ctx: Ctx,
  agent_: Address,
  target_: Address,
  value: bigint,
  data: Hex,
): { intentId: bigint; verdict: VerdictValue } {
  const state = ctx.world.escalationRouter;
  const self = ctx.world.addresses.escalationRouter;
  const agent = addr(agent_);
  const target = addr(target_);

  const agentNode = readNode(ctx, agent);
  if (!agentNode.active) throw new SimRevert("InactiveAgent", { agent });
  requireUnprotectedTarget(ctx, agent, target);
  const scopeMask = requireValidSession(ctx, agent, target, value);
  // Count this propose against the key's rate limit (no-op unless wired and
  // the key has one).
  if (state.sessionRegistry !== ZERO_ADDRESS) {
    requireSessionRegistry(ctx);
    sessionRegistry.recordProposal(asSender(ctx, self), agent, ctx.sender);
  }

  const verdict = policies.check(ctx, policyFor(ctx, agent), agent, target, value, data);

  if (verdict === Verdict.DENY) throw new SimRevert("UnexpectedVerdict", { verdict });

  if (verdict === Verdict.ALLOW) {
    requireSpendScope(ctx, agent, scopeMask);
    finalizeAction(ctx, agent, target, value, data);
    return { intentId: 0n, verdict };
  }

  if (agentNode.parent === ZERO_ADDRESS) throw new SimRevert("NoApprover", { agent });

  const intentId = state.nextIntentId++;
  state.intents[intentId.toString()] = {
    agent,
    target,
    value,
    data,
    awaitingApprover: agentNode.parent,
    resolved: false,
    approved: false,
  };

  recordRate(ctx, agent);
  emit(ctx, self, CONTRACT, "IntentCreated", {
    intentId,
    agent,
    awaitingApprover: agentNode.parent,
  });
  return { intentId, verdict };
}

/**
 * Approve or reject a pending intent. Only a node that is in the tree and
 * active resolves; the org root stands in for an awaiting approver that is
 * inactive or removed; and an approval needs the proposing agent to still be
 * active, while a rejection does not.
 */
export function resolve(ctx: Ctx, intentId: bigint, approved: boolean): void {
  const state = ctx.world.escalationRouter;
  const self = ctx.world.addresses.escalationRouter;
  const intent = state.intents[intentId.toString()];
  if (!intent || intent.agent === ZERO_ADDRESS) throw new SimRevert("IntentNotFound", { intentId });
  if (intent.resolved) throw new SimRevert("IntentAlreadyResolved", { intentId });
  const awaiting = intent.awaitingApprover;
  if (ctx.sender === awaiting) {
    if (!isActiveNode(ctx, awaiting))
      throw new SimRevert("InactiveApprover", { approver: awaiting });
  } else if (ctx.sender !== registryRoot(ctx) || isActiveNode(ctx, awaiting)) {
    throw new SimRevert("NotAwaitingApprover", { caller: ctx.sender });
  }

  if (!approved) {
    intent.resolved = true;
    intent.approved = false;
    emit(ctx, self, CONTRACT, "IntentResolved", { intentId, approved: false });
    return;
  }

  if (!isActiveNode(ctx, intent.agent))
    throw new SimRevert("InactiveAgent", { agent: intent.agent });

  const verdict = policies.check(
    ctx,
    policyFor(ctx, ctx.sender),
    ctx.sender,
    intent.target,
    intent.value,
    intent.data,
  );

  if (verdict === Verdict.DENY) {
    intent.resolved = true;
    intent.approved = false;
    emit(ctx, self, CONTRACT, "IntentResolved", { intentId, approved: false });
    return;
  }

  if (verdict === Verdict.ALLOW) {
    intent.resolved = true;
    intent.approved = true;
    finalizeAction(ctx, intent.agent, intent.target, intent.value, intent.data);
    emit(ctx, self, CONTRACT, "IntentResolved", { intentId, approved: true });
    return;
  }

  const approver = readNode(ctx, ctx.sender);
  if (approver.parent === ZERO_ADDRESS || approver.kind === orgRegistry.NodeKind.HumanRoot) {
    // Root reserved authority finalizes.
    intent.resolved = true;
    intent.approved = true;
    finalizeAction(ctx, intent.agent, intent.target, intent.value, intent.data);
    emit(ctx, self, CONTRACT, "IntentResolved", { intentId, approved: true });
    return;
  }

  const nextApprover = approver.parent;
  const previous = intent.awaitingApprover;
  intent.awaitingApprover = nextApprover;
  emit(ctx, self, CONTRACT, "IntentEscalated", { intentId, from: previous, to: nextApprover });
}

/** `intents(id)`: the stored struct, or the zero struct for an unknown id. */
export function intents(ctx: Ctx, intentId: bigint): IntentState {
  return {
    ...(ctx.world.escalationRouter.intents[intentId.toString()] ?? {
      agent: ZERO_ADDRESS,
      target: ZERO_ADDRESS,
      value: 0n,
      data: "0x",
      awaitingApprover: ZERO_ADDRESS,
      resolved: false,
      approved: false,
    }),
  };
}

function finalizeAction(ctx: Ctx, agent: Address, target: Address, value: bigint, data: Hex): void {
  const state = ctx.world.escalationRouter;
  const self = ctx.world.addresses.escalationRouter;
  if (state.treasury !== ZERO_ADDRESS && value > 0n) {
    if (state.treasury !== ctx.world.addresses.treasury) throw new SimRevert(EVM_REVERT);
    treasury.spendAllowance(asSender(ctx, self), agent, value, target);
  }

  let callOk = true;
  if (byteLength(data) > 0) {
    callOk = externalCall(ctx, self, target, data);
  }
  recordRate(ctx, agent);
  emit(ctx, self, CONTRACT, "ActionExecuted", { agent, target, value, callOk });
}

function recordRate(ctx: Ctx, agent: Address): void {
  const state = ctx.world.escalationRouter;
  let recorder = state.rateRecorderOf[agent] ?? ZERO_ADDRESS;
  if (recorder === ZERO_ADDRESS) recorder = state.rateRecorder;
  if (recorder !== ZERO_ADDRESS) {
    policies.record(asSender(ctx, ctx.world.addresses.escalationRouter), recorder, agent);
  }
}

/**
 * Unset registry = bootstrap. Otherwise: valid session + scope + maxValue +
 * target + time window. Returns the granted scope mask; every bit when the
 * registry is unset or the agent is acting for itself.
 */
function requireValidSession(ctx: Ctx, agent: Address, target: Address, value: bigint): bigint {
  const state = ctx.world.escalationRouter;
  if (state.sessionRegistry === ZERO_ADDRESS) return MAX_UINT256;
  if (ctx.sender === agent) return MAX_UINT256;
  requireSessionRegistry(ctx);
  const { valid, maxValue, allowedTarget, scopeMask } = sessionRegistry.keyLimits(
    ctx,
    agent,
    ctx.sender,
  );
  if (!valid) throw new SimRevert("InvalidSession", { agent, key: ctx.sender });
  if ((scopeMask & sessionRegistry.SCOPE_PROPOSE_INTENT) === 0n) {
    throw new SimRevert("SessionScopeDenied", {
      agent,
      required: sessionRegistry.SCOPE_PROPOSE_INTENT,
      granted: scopeMask,
    });
  }
  if (value > maxValue) throw new SimRevert("SessionValueExceeded", { agent, value, maxValue });
  if (!sessionRegistry.isTargetAllowed(ctx, agent, ctx.sender, target)) {
    throw new SimRevert("SessionTargetDenied", { agent, target, allowedTarget });
  }
  if (!sessionRegistry.withinTimeWindow(ctx, agent, ctx.sender)) {
    throw new SimRevert("SessionTimeWindowDenied", { agent });
  }
  return scopeMask;
}

function requireSpendScope(ctx: Ctx, agent: Address, scopeMask: bigint): void {
  if (ctx.world.escalationRouter.sessionRegistry === ZERO_ADDRESS) return;
  if ((scopeMask & sessionRegistry.SCOPE_SPEND_WHITELIST) === 0n) {
    throw new SimRevert("SessionScopeDenied", {
      agent,
      required: sessionRegistry.SCOPE_SPEND_WHITELIST,
      granted: scopeMask,
    });
  }
}

/** Refuses the contracts that trust the router as `msg.sender`, whatever the policy says. */
function requireUnprotectedTarget(ctx: Ctx, agent: Address, target: Address): void {
  const state = ctx.world.escalationRouter;
  // Unwired slots are zero; a zero target must not match them.
  if (target === ZERO_ADDRESS) return;
  if (
    target === ctx.world.addresses.escalationRouter ||
    target === state.treasury ||
    target === state.sessionRegistry ||
    target === state.rateRecorder ||
    target === (state.rateRecorderOf[agent] ?? ZERO_ADDRESS)
  ) {
    throw new SimRevert("ProtectedTarget", { target });
  }
}

function policyFor(ctx: Ctx, node: Address): Address {
  const state = ctx.world.escalationRouter;
  const nodePolicy = state.policyOf[node] ?? ZERO_ADDRESS;
  if (nodePolicy !== ZERO_ADDRESS) return nodePolicy;
  return state.policy;
}

/** Governor once bound; the deployer until then. */
function onlyGovernorOrBootstrap(ctx: Ctx): void {
  const state = ctx.world.escalationRouter;
  const authority = state.governor === ZERO_ADDRESS ? state.deployer : state.governor;
  if (ctx.sender !== authority) throw new SimRevert("NotAuthorized", { caller: ctx.sender });
}

/** `orgRegistry.getNode`: the registry address is immutable, and only the simulated one has code. */
function readNode(ctx: Ctx, account: Address): orgRegistry.OrgNodeState {
  if (ctx.world.escalationRouter.orgRegistry !== ctx.world.addresses.orgRegistry) {
    throw new SimRevert(EVM_REVERT);
  }
  return orgRegistry.getNode(ctx, account);
}

/** `orgRegistry.root()`, under the same condition as `readNode`. */
function registryRoot(ctx: Ctx): Address {
  if (ctx.world.escalationRouter.orgRegistry !== ctx.world.addresses.orgRegistry) {
    throw new SimRevert(EVM_REVERT);
  }
  return ctx.world.orgRegistry.root;
}

/**
 * In the tree and active. A removed node reads as inactive, as the contract's
 * `try` around `getNode` makes it; a registry with no code still reverts,
 * because that failure happens before the call a `try` can catch.
 */
function isActiveNode(ctx: Ctx, account: Address): boolean {
  if (ctx.world.escalationRouter.orgRegistry !== ctx.world.addresses.orgRegistry) {
    throw new SimRevert(EVM_REVERT);
  }
  const node = ctx.world.orgRegistry.nodes[account];
  return node !== undefined && node.account !== ZERO_ADDRESS && node.active;
}

/** A wired session registry that is not the simulated one has no `keyLimits` to answer. */
function requireSessionRegistry(ctx: Ctx): void {
  if (ctx.world.escalationRouter.sessionRegistry !== ctx.world.addresses.sessionRegistry) {
    throw new SimRevert(EVM_REVERT);
  }
}
