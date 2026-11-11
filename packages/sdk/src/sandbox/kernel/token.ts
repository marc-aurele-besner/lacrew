/**
 * The spend token: the ERC-20 surface of `contracts/src/mocks/MockUSDC.sol`
 * the Treasury moves funds through — balances, allowances, and the
 * owner-or-minter `mint`. Revert names are OpenZeppelin's ERC-20 errors.
 */

import { emit } from "./frame.js";
import { MAX_UINT256, SimRevert, ZERO_ADDRESS, addr, checkedAdd, type Address } from "./types.js";
import type { Ctx } from "./world.js";

const CONTRACT = "MockUSDC";

export interface TokenState {
  owner: Address;
  minters: Record<Address, boolean>;
  totalSupply: bigint;
  balances: Record<Address, bigint>;
  allowances: Record<Address, Record<Address, bigint>>;
}

export function blankToken(): TokenState {
  return { owner: ZERO_ADDRESS, minters: {}, totalSupply: 0n, balances: {}, allowances: {} };
}

export function deploy(ctx: Ctx, address: Address): void {
  ctx.world.addresses.token = address;
  ctx.world.token = { ...blankToken(), owner: ctx.sender };
}

export function balanceOf(ctx: Ctx, account: Address): bigint {
  return ctx.world.token.balances[addr(account)] ?? 0n;
}

export function allowance(ctx: Ctx, owner: Address, spender: Address): bigint {
  return ctx.world.token.allowances[addr(owner)]?.[addr(spender)] ?? 0n;
}

export function setMinter(ctx: Ctx, account: Address, allowed: boolean): void {
  const state = ctx.world.token;
  if (ctx.sender !== state.owner) throw new SimRevert("NotOwner", { caller: ctx.sender });
  state.minters[addr(account)] = allowed;
  emit(ctx, ctx.world.addresses.token, CONTRACT, "MinterUpdated", {
    account: addr(account),
    allowed,
  });
}

export function mint(ctx: Ctx, to_: Address, amount: bigint): void {
  const state = ctx.world.token;
  const to = addr(to_);
  if (ctx.sender !== state.owner && !state.minters[ctx.sender]) {
    throw new SimRevert("NotMinter", { caller: ctx.sender });
  }
  if (to === ZERO_ADDRESS) throw new SimRevert("ERC20InvalidReceiver", { receiver: to });
  state.totalSupply = checkedAdd(state.totalSupply, amount);
  state.balances[to] = (state.balances[to] ?? 0n) + amount;
  emit(ctx, ctx.world.addresses.token, CONTRACT, "Transfer", {
    from: ZERO_ADDRESS,
    to,
    value: amount,
  });
}

export function transfer(ctx: Ctx, to: Address, value: bigint): boolean {
  move(ctx, ctx.sender, addr(to), value);
  return true;
}

export function approve(ctx: Ctx, spender_: Address, value: bigint): boolean {
  const spender = addr(spender_);
  if (spender === ZERO_ADDRESS) throw new SimRevert("ERC20InvalidSpender", { spender });
  (ctx.world.token.allowances[ctx.sender] ??= {})[spender] = value;
  emit(ctx, ctx.world.addresses.token, CONTRACT, "Approval", {
    owner: ctx.sender,
    spender,
    value,
  });
  return true;
}

export function transferFrom(ctx: Ctx, from_: Address, to: Address, value: bigint): boolean {
  const from = addr(from_);
  const current = allowance(ctx, from, ctx.sender);
  // An unlimited approval is never drawn down.
  if (current < MAX_UINT256) {
    if (current < value) {
      throw new SimRevert("ERC20InsufficientAllowance", {
        spender: ctx.sender,
        allowance: current,
        needed: value,
      });
    }
    (ctx.world.token.allowances[from] ??= {})[ctx.sender] = current - value;
  }
  move(ctx, from, addr(to), value);
  return true;
}

function move(ctx: Ctx, from: Address, to: Address, value: bigint): void {
  const state = ctx.world.token;
  if (from === ZERO_ADDRESS) throw new SimRevert("ERC20InvalidSender", { sender: from });
  if (to === ZERO_ADDRESS) throw new SimRevert("ERC20InvalidReceiver", { receiver: to });
  const balance = state.balances[from] ?? 0n;
  if (balance < value) {
    throw new SimRevert("ERC20InsufficientBalance", { sender: from, balance, needed: value });
  }
  state.balances[from] = balance - value;
  state.balances[to] = (state.balances[to] ?? 0n) + value;
  emit(ctx, ctx.world.addresses.token, CONTRACT, "Transfer", { from, to, value });
}
