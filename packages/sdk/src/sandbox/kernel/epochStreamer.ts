/**
 * EpochStreamer: streams fixed grants to configured nodes once per epoch.
 * Mirrors `contracts/src/EpochStreamer.sol`.
 */

import { asSender, emit } from "./frame.js";
import * as treasury from "./treasury.js";
import { EVM_REVERT, SimRevert, ZERO_ADDRESS, addr, checkedAdd, type Address } from "./types.js";
import type { Ctx } from "./world.js";

const CONTRACT = "EpochStreamer";

export interface EpochStreamerState {
  treasury: Address;
  operator: Address;
  governor: Address;
  currentEpoch: bigint;
  grantAmount: Record<Address, bigint>;
  recipients: Address[];
  /** Keyed by epoch id as a decimal string. */
  epochCompleted: Record<string, boolean>;
}

export function blankEpochStreamer(): EpochStreamerState {
  return {
    treasury: ZERO_ADDRESS,
    operator: ZERO_ADDRESS,
    governor: ZERO_ADDRESS,
    currentEpoch: 0n,
    grantAmount: {},
    recipients: [],
    epochCompleted: {},
  };
}

export function deploy(ctx: Ctx, address: Address, treasury_: Address, operator_: Address): void {
  if (addr(treasury_) === ZERO_ADDRESS || addr(operator_) === ZERO_ADDRESS) {
    throw new SimRevert("ZeroAddress");
  }
  ctx.world.addresses.epochStreamer = address;
  ctx.world.epochStreamer = {
    ...blankEpochStreamer(),
    treasury: addr(treasury_),
    operator: addr(operator_),
  };
}

export function setOperator(ctx: Ctx, operator_: Address): void {
  onlyOperator(ctx);
  const operator = addr(operator_);
  if (operator === ZERO_ADDRESS) throw new SimRevert("ZeroAddress");
  ctx.world.epochStreamer.operator = operator;
  emit(ctx, ctx.world.addresses.epochStreamer, CONTRACT, "OperatorUpdated", { operator });
}

export function setGovernor(ctx: Ctx, governor_: Address): void {
  onlyOperator(ctx);
  const state = ctx.world.epochStreamer;
  const governor = addr(governor_);
  if (governor === ZERO_ADDRESS) throw new SimRevert("ZeroAddress");
  if (state.governor !== ZERO_ADDRESS) throw new SimRevert("GovernorAlreadySet");
  state.governor = governor;
  emit(ctx, ctx.world.addresses.epochStreamer, CONTRACT, "GovernorUpdated", { governor });
}

export function setGrant(ctx: Ctx, node: Address, amount: bigint): void {
  const state = ctx.world.epochStreamer;
  if (ctx.sender !== state.operator && ctx.sender !== state.governor) {
    throw new SimRevert("NotAuthorized", { caller: ctx.sender });
  }
  setGrantInternal(ctx, node, amount);
}

export function setGrants(ctx: Ctx, nodes: Address[], amounts: bigint[]): void {
  const state = ctx.world.epochStreamer;
  if (ctx.sender !== state.operator && ctx.sender !== state.governor) {
    throw new SimRevert("NotAuthorized", { caller: ctx.sender });
  }
  if (nodes.length !== amounts.length) throw new SimRevert("LengthMismatch");
  for (let i = 0; i < nodes.length; i++) {
    setGrantInternal(ctx, nodes[i]!, amounts[i]!);
  }
}

function setGrantInternal(ctx: Ctx, node_: Address, amount: bigint): void {
  const state = ctx.world.epochStreamer;
  const node = addr(node_);
  if (node === ZERO_ADDRESS) throw new SimRevert("ZeroAddress");
  const isRecipient = state.recipients.includes(node);
  if (amount === 0n) {
    if (isRecipient) {
      state.grantAmount[node] = 0n;
      removeRecipient(state, node);
    }
  } else {
    state.grantAmount[node] = amount;
    if (!isRecipient) state.recipients.push(node);
  }
  emit(ctx, ctx.world.addresses.epochStreamer, CONTRACT, "GrantUpdated", { node, amount });
}

export function recipients(ctx: Ctx): Address[] {
  return [...ctx.world.epochStreamer.recipients];
}

export function grantAmount(ctx: Ctx, node: Address): bigint {
  return ctx.world.epochStreamer.grantAmount[addr(node)] ?? 0n;
}

/** Advance `currentEpoch` and stream all grants. */
export function runNextEpoch(ctx: Ctx): bigint {
  onlyOperator(ctx);
  const epoch = checkedAdd(ctx.world.epochStreamer.currentEpoch, 1n, 64);
  runEpochInternal(ctx, epoch);
  ctx.world.epochStreamer.currentEpoch = epoch;
  return epoch;
}

/** Stream grants for an explicit epoch id (must not have run before). */
export function runEpoch(ctx: Ctx, epoch: bigint): void {
  onlyOperator(ctx);
  runEpochInternal(ctx, epoch);
  const state = ctx.world.epochStreamer;
  if (epoch > state.currentEpoch) state.currentEpoch = epoch;
}

function runEpochInternal(ctx: Ctx, epoch: bigint): void {
  const state = ctx.world.epochStreamer;
  const self = ctx.world.addresses.epochStreamer;
  if (state.epochCompleted[epoch.toString()]) throw new SimRevert("EpochAlreadyRun", { epoch });
  const n = state.recipients.length;
  if (n === 0) throw new SimRevert("EmptySchedule");

  state.epochCompleted[epoch.toString()] = true;
  for (const node of state.recipients) {
    const amount = state.grantAmount[node] ?? 0n;
    if (amount === 0n) continue;
    if (state.treasury !== ctx.world.addresses.treasury) throw new SimRevert(EVM_REVERT);
    treasury.streamAllowance(asSender(ctx, self), node, amount, epoch);
  }
  emit(ctx, self, CONTRACT, "EpochRun", { epoch, recipientCount: BigInt(n) });
}

/** Swap-and-pop, so recipient order matches the contract's after a removal. */
function removeRecipient(state: EpochStreamerState, node: Address): void {
  const n = state.recipients.length;
  for (let i = 0; i < n; i++) {
    if (state.recipients[i] === node) {
      state.recipients[i] = state.recipients[n - 1]!;
      state.recipients.pop();
      return;
    }
  }
}

function onlyOperator(ctx: Ctx): void {
  if (ctx.sender !== ctx.world.epochStreamer.operator) {
    throw new SimRevert("NotOperator", { caller: ctx.sender });
  }
}
