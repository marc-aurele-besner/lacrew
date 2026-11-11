/**
 * What a scenario needs from the thing it runs against.
 *
 * Both drivers keep the same notion of time: `now()` is the timestamp of the
 * last block, a transaction runs one second later, and a reverted call leaves
 * the time where it was. Reads see the state as of `now()`.
 */

import type { ProtocolClient } from "@lacrew/sdk";

import type { AddressBook, Address, ContractKind, GenesisOptions, Hex } from "./refs.js";

/** A log, by the contract kind that emitted it and its ABI event name. */
export interface DriverEvent {
  /** The emitting contract's address on this driver. */
  address: Address;
  name: string;
  args: Record<string, unknown>;
}

export type TxOutcome =
  | { ok: true; events: DriverEvent[] }
  /** `revert` is the custom error name; `Panic` and `EvmRevert` stand for the two that have none. */
  | { ok: false; revert: string };

export type DeployOutcome = { ok: true; address: Address } | { ok: false; revert: string };

export interface RawIntent {
  agent: Address;
  target: Address;
  value: bigint;
  data: Hex;
  awaitingApprover: Address;
  resolved: boolean;
  approved: boolean;
}

export interface Driver {
  readonly name: string;
  /** Deploy a fresh org with these options and move the clock to the suite's start time. */
  reset(genesis: GenesisOptions): Promise<void>;
  /** The org's human root reads through this client. */
  readonly client: ProtocolClient;
  readonly book: AddressBook;
  now(): number;
  send(from: Address, to: Address, data: Hex): Promise<TxOutcome>;
  deploy(from: Address, contract: ContractKind, args: readonly unknown[]): Promise<DeployOutcome>;
  warp(seconds: number): Promise<void>;
  readIntent(id: bigint): Promise<RawIntent>;
  balanceOf(account: Address): Promise<bigint>;
  close(): Promise<void>;
}

/** Genesis of every driver, and where the clock stands once an org is deployed. */
export const GENESIS_TIME = 1_700_000_000;
/** 81 000 seconds into its UTC day. */
export const START_TIME = GENESIS_TIME + 1_000;
