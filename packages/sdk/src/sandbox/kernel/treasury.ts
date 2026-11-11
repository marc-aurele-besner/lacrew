/**
 * Treasury: holds the org's funds and streams allowances downward.
 * Mirrors `contracts/src/Treasury.sol`.
 */

import { asSender, emit } from "./frame.js";
import * as token from "./token.js";
import { EVM_REVERT, SimRevert, ZERO_ADDRESS, addr, type Address } from "./types.js";
import type { Ctx } from "./world.js";

const CONTRACT = "Treasury";

export interface TreasuryState {
  orgRegistry: Address;
  token: Address;
  /** Holds bootstrap authority until `governor` is bound. */
  deployer: Address;
  spender: Address;
  governor: Address;
  streamer: Address;
  totalReserved: bigint;
  allowanceBalance: Record<Address, bigint>;
}

export function blankTreasury(): TreasuryState {
  return {
    orgRegistry: ZERO_ADDRESS,
    token: ZERO_ADDRESS,
    deployer: ZERO_ADDRESS,
    spender: ZERO_ADDRESS,
    governor: ZERO_ADDRESS,
    streamer: ZERO_ADDRESS,
    totalReserved: 0n,
    allowanceBalance: {},
  };
}

export function deploy(
  ctx: Ctx,
  address: Address,
  orgRegistry_: Address,
  token_: Address,
  spender_: Address,
): void {
  if (addr(orgRegistry_) === ZERO_ADDRESS || addr(token_) === ZERO_ADDRESS) {
    throw new SimRevert("ZeroAddress");
  }
  ctx.world.addresses.treasury = address;
  ctx.world.treasury = {
    ...blankTreasury(),
    orgRegistry: addr(orgRegistry_),
    token: addr(token_),
    spender: addr(spender_),
    deployer: ctx.sender,
  };
}

export function setGovernor(ctx: Ctx, governor_: Address): void {
  const governor = addr(governor_);
  if (governor === ZERO_ADDRESS) throw new SimRevert("ZeroAddress");
  onlyGovernorOrBootstrap(ctx);
  ctx.world.treasury.governor = governor;
  emit(ctx, ctx.world.addresses.treasury, CONTRACT, "GovernorUpdated", { governor });
}

export function setStreamer(ctx: Ctx, streamer_: Address): void {
  const streamer = addr(streamer_);
  onlyGovernorOrBootstrap(ctx);
  ctx.world.treasury.streamer = streamer;
  emit(ctx, ctx.world.addresses.treasury, CONTRACT, "StreamerUpdated", { streamer });
}

export function setSpender(ctx: Ctx, spender_: Address): void {
  const spender = addr(spender_);
  onlyGovernorOrBootstrap(ctx);
  if (spender === ZERO_ADDRESS) throw new SimRevert("ZeroAddress");
  ctx.world.treasury.spender = spender;
  emit(ctx, ctx.world.addresses.treasury, CONTRACT, "SpenderUpdated", { spender });
}

export function deposit(ctx: Ctx, amount: bigint): void {
  const self = ctx.world.addresses.treasury;
  requireToken(ctx);
  token.transferFrom(asSender(ctx, self), ctx.sender, self, amount);
  emit(ctx, self, CONTRACT, "Deposited", { from: ctx.sender, amount });
}

export function streamAllowance(ctx: Ctx, node_: Address, amount: bigint, epoch: bigint): void {
  const state = ctx.world.treasury;
  const node = addr(node_);
  if (state.governor !== ZERO_ADDRESS || state.streamer !== ZERO_ADDRESS) {
    if (ctx.sender !== state.governor && ctx.sender !== state.streamer) {
      throw new SimRevert("NotAuthorized", { caller: ctx.sender });
    }
  } else if (ctx.sender !== state.deployer) {
    throw new SimRevert("NotAuthorized", { caller: ctx.sender });
  }
  const liquid = liquidBalance(ctx);
  if (liquid < amount) {
    throw new SimRevert("InsufficientTreasury", { requested: amount, available: liquid });
  }

  state.allowanceBalance[node] = (state.allowanceBalance[node] ?? 0n) + amount;
  state.totalReserved += amount;
  emit(ctx, ctx.world.addresses.treasury, CONTRACT, "AllowanceStreamed", { node, amount, epoch });
}

/**
 * Both `spendAllowance` overloads: with `to`, tokens go to that recipient
 * (and a zero recipient is refused); without it, they go to the spender.
 */
export function spendAllowance(ctx: Ctx, node: Address, amount: bigint, to?: Address): void {
  const state = ctx.world.treasury;
  if (ctx.sender !== state.spender) throw new SimRevert("NotSpender", { caller: ctx.sender });
  if (to === undefined) {
    spend(ctx, addr(node), amount, ctx.sender);
    return;
  }
  if (addr(to) === ZERO_ADDRESS) throw new SimRevert("ZeroAddress");
  spend(ctx, addr(node), amount, addr(to));
}

export function liquidBalance(ctx: Ctx): bigint {
  requireToken(ctx);
  const bal = token.balanceOf(ctx, ctx.world.addresses.treasury);
  const reserved = ctx.world.treasury.totalReserved;
  return bal > reserved ? bal - reserved : 0n;
}

/** Governor once bound; the deployer until then. */
function onlyGovernorOrBootstrap(ctx: Ctx): void {
  const state = ctx.world.treasury;
  const authority = state.governor === ZERO_ADDRESS ? state.deployer : state.governor;
  if (ctx.sender !== authority) throw new SimRevert("NotAuthorized", { caller: ctx.sender });
}

function spend(ctx: Ctx, node: Address, amount: bigint, to: Address): void {
  const state = ctx.world.treasury;
  const self = ctx.world.addresses.treasury;
  const available = state.allowanceBalance[node] ?? 0n;
  if (available < amount) {
    throw new SimRevert("InsufficientAllowance", { node, requested: amount, available });
  }
  state.allowanceBalance[node] = available - amount;
  state.totalReserved -= amount;
  requireToken(ctx);
  token.transfer(asSender(ctx, self), to, amount);
  emit(ctx, self, CONTRACT, "AllowanceSpent", { node, amount, to });
}

/** The token is an immutable address; anything but the simulated token has no code to call. */
function requireToken(ctx: Ctx): void {
  if (ctx.world.treasury.token !== ctx.world.addresses.token) throw new SimRevert(EVM_REVERT);
}
