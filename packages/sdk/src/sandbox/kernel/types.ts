/**
 * Shared vocabulary of the sandbox kernel.
 *
 * The kernel is the contracts restated in TypeScript: one file per contract,
 * the same function names, the same checks in the same order, the same custom
 * error names on failure. It holds no chain library and no wall clock — time
 * arrives as `ctx.now`, and anything that needs hashing or calldata decoding
 * arrives through `KernelEnv`.
 *
 * Every Solidity `uint` is a `bigint` here, enums are their ABI numbers, and
 * addresses are lowercase hex strings, so state is plain data.
 */

export type Address = `0x${string}`;
export type Hex = `0x${string}`;

export const ZERO_ADDRESS: Address = "0x0000000000000000000000000000000000000000";
export const MAX_UINT256 = 2n ** 256n - 1n;
export const MAX_UINT64 = 2n ** 64n - 1n;
export const MAX_UINT32 = 2n ** 32n - 1n;
export const ONE_DAY = 86_400n;

/** Storage keys are lowercase, so two spellings of one address are one slot. */
export function addr(value: string): Address {
  return value.toLowerCase() as Address;
}

/**
 * A reverted call. `errorName` is the Solidity custom error the contract would
 * have raised, so a caller can tell the simulator's refusal from the chain's by
 * nothing but where it came from.
 *
 * Two names stand for reverts that carry no custom error: `Panic` (checked
 * arithmetic overflow) and `EvmRevert` (a call into an address with no such
 * function, which the EVM rejects with empty return data).
 */
export class SimRevert extends Error {
  constructor(
    readonly errorName: string,
    readonly args: Record<string, unknown> = {},
  ) {
    super(errorName);
    this.name = "SimRevert";
  }
}

export const PANIC = "Panic";
export const EVM_REVERT = "EvmRevert";

/** Checked `a + b` in a `bits`-wide unsigned integer, as Solidity 0.8 does it. */
export function checkedAdd(a: bigint, b: bigint, bits = 256): bigint {
  const sum = a + b;
  if (sum >= 2n ** BigInt(bits)) throw new SimRevert(PANIC);
  return sum;
}

/** Checked `a - b`: underflow panics. */
export function checkedSub(a: bigint, b: bigint): bigint {
  if (b > a) throw new SimRevert(PANIC);
  return a - b;
}

/** The only source of time. Unix seconds, like `block.timestamp`. */
export interface Clock {
  now(): number;
}

/** An emitted log: the contract that emitted it, the ABI event name, its named arguments. */
export interface SimEvent {
  address: Address;
  contract: string;
  name: string;
  args: Record<string, unknown>;
}

/** What the kernel cannot do without a chain library. */
export interface KernelEnv {
  /**
   * Run `target.call(data)` with `ctx.sender` as the caller. Returns for a
   * successful call (including one to an address that holds no contract) and
   * throws `SimRevert` when the callee reverts.
   */
  dispatch(ctx: CallContext, target: Address, data: Hex): void;
  /** `keccak256(abi.encode(target, data))`, the hash a governance proposal is bound to. */
  actionHash(target: Address, data: Hex): Hex;
}

/** One call frame: who is calling, when, against which state. */
export interface CallContext<W = unknown> {
  world: W;
  /** `msg.sender`. */
  sender: Address;
  /** `block.timestamp`. */
  now: bigint;
  /** Logs of the enclosing transaction, in emission order. */
  events: SimEvent[];
  env: KernelEnv;
}

/** Byte length of a hex string (`"0x"` is zero bytes). */
export function byteLength(data: Hex): number {
  return (data.length - 2) / 2;
}
