/**
 * The cast and the stage: who acts in a scenario, which contracts exist, and
 * how a scenario names either without knowing an address.
 *
 * Actors are fixed addresses, the same on every driver. Contracts are named by
 * role (`@router`) because the simulator and a chain deploy them at different
 * addresses; a module a scenario deploys itself is named by its label
 * (`$stack`).
 */

import type { Abi } from "viem";
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

export type Address = `0x${string}`;
export type Hex = `0x${string}`;

export const ZERO: Address = "0x0000000000000000000000000000000000000000";

const named = (byte: string): Address => `0x${byte.repeat(20)}` as Address;

/** Every account a scenario may act as or point at. */
export const ACTORS = {
  root: named("a1"),
  human2: named("a2"),
  manager: named("b1"),
  manager2: named("b2"),
  worker: named("c1"),
  worker2: named("c2"),
  stranger: named("d1"),
  issuer: named("d2"),
  operator2: named("d3"),
  minter: named("d4"),
  target: named("e1"),
  target2: named("e2"),
  key: named("f1"),
  key2: named("f2"),
} as const;

export type Actor = keyof typeof ACTORS;

/** The contracts whose ABIs the simulator answers. */
export const ABIS = {
  MockUSDC: mockUsdcAbi as Abi,
  OrgRegistry: orgRegistryAbi as Abi,
  GovernanceModule: governanceModuleAbi as Abi,
  Treasury: treasuryAbi as Abi,
  EscalationRouter: escalationRouterAbi as Abi,
  EpochStreamer: epochStreamerAbi as Abi,
  SessionRegistry: sessionRegistryAbi as Abi,
  WhitelistPolicy: whitelistPolicyAbi as Abi,
  SpendCapPolicy: spendCapPolicyAbi as Abi,
  RateLimitPolicy: rateLimitPolicyAbi as Abi,
  TimeWindowPolicy: timeWindowPolicyAbi as Abi,
  PolicyStack: policyStackAbi as Abi,
} as const;

export type ContractKind = keyof typeof ABIS;

/** The contracts of a fresh org, by role, and the kind each one is. */
export const ROLES = {
  token: "MockUSDC",
  registry: "OrgRegistry",
  gov: "GovernanceModule",
  treasury: "Treasury",
  router: "EscalationRouter",
  streamer: "EpochStreamer",
  sessions: "SessionRegistry",
  whitelist: "WhitelistPolicy",
  spendCap: "SpendCapPolicy",
  rateLimit: "RateLimitPolicy",
  timeWindow: "TimeWindowPolicy",
  policyStack: "PolicyStack",
  managerStack: "PolicyStack",
} as const satisfies Record<string, ContractKind>;

export type Role = keyof typeof ROLES;

/** Where each role lives on one driver. */
export type AddressBook = Record<Role, Address>;

/** How a fresh org is configured; every driver deploys from the same options. */
export interface GenesisOptions {
  rootPower?: bigint;
  defaultCap?: bigint;
  rateLimit?: { maxActions: bigint; windowSeconds: bigint };
  timeWindow?: { startSecondOfDay: bigint; endSecondOfDay: bigint };
  bindGovernor?: boolean;
}

/**
 * A name a scenario uses for an address: an actor (`worker`), a role
 * (`@router`), a module the scenario deployed (`$stack`), `zero`, or a literal
 * 20-byte hex address.
 */
export type Ref = string;

export const isAddress = (value: string): value is Address => /^0x[0-9a-fA-F]{40}$/.test(value);

/** Resolves refs against one driver's deployment, and names addresses back for comparison. */
export class Names {
  private readonly deployed = new Map<string, { address: Address; kind: ContractKind }>();

  constructor(private readonly book: AddressBook) {}

  /** Record a module a scenario deployed under `label`. */
  define(label: string, address: Address, kind: ContractKind): void {
    this.deployed.set(label, { address, kind });
  }

  address(ref: Ref): Address {
    if (ref === "zero") return ZERO;
    if (isAddress(ref)) return ref;
    if (ref.startsWith("@")) {
      const address = this.book[ref.slice(1) as Role];
      if (!address) throw new Error(`unknown contract role "${ref}"`);
      return address;
    }
    if (ref.startsWith("$")) {
      const found = this.deployed.get(ref.slice(1));
      if (!found) throw new Error(`"${ref}" was used before the scenario deployed it`);
      return found.address;
    }
    const actor = ACTORS[ref as Actor];
    if (!actor) throw new Error(`unknown actor "${ref}"`);
    return actor;
  }

  /** The contract kind behind a ref, for picking its ABI. */
  kind(ref: Ref): ContractKind {
    if (ref.startsWith("@")) {
      const kind = ROLES[ref.slice(1) as Role];
      if (!kind) throw new Error(`unknown contract role "${ref}"`);
      return kind;
    }
    if (ref.startsWith("$")) {
      const found = this.deployed.get(ref.slice(1));
      if (!found) throw new Error(`"${ref}" was used before the scenario deployed it`);
      return found.kind;
    }
    throw new Error(`"${ref}" is not a contract`);
  }

  /** Every contract address on this driver with the driver-independent name it goes by. */
  labels(): Map<string, string> {
    const out = new Map<string, string>();
    for (const [role, address] of Object.entries(this.book)) {
      out.set(address.toLowerCase(), `@${role}`);
    }
    for (const [label, { address }] of this.deployed) out.set(address.toLowerCase(), `$${label}`);
    return out;
  }

  /** Each contract address with its kind, for decoding what it emitted. */
  contracts(): Map<string, ContractKind> {
    const out = new Map<string, ContractKind>();
    for (const [role, address] of Object.entries(this.book)) {
      out.set(address.toLowerCase(), ROLES[role as Role]);
    }
    for (const { address, kind } of this.deployed.values()) out.set(address.toLowerCase(), kind);
    return out;
  }
}

/**
 * Make a value comparable across drivers: integers become decimal strings,
 * hex is lowercased, and every contract address — standing alone or embedded
 * in calldata — is replaced by the name it goes by. Object keys are sorted.
 */
export function normalise(value: unknown, labels: Map<string, string>): unknown {
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "string") {
    if (!/^0x[0-9a-fA-F]*$/.test(value)) return value;
    let out = value.toLowerCase();
    for (const [address, label] of labels) {
      if (out === address) return label;
      out = out.split(address.slice(2)).join(`<${label}>`);
    }
    return out;
  }
  if (Array.isArray(value)) return value.map((entry) => normalise(entry, labels));
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const entry = (value as Record<string, unknown>)[key];
      if (entry === undefined) continue;
      // A proposal's action hash covers its target's address, which differs by driver.
      out[key] = key === "actionHash" ? "<hash>" : normalise(entry, labels);
    }
    return out;
  }
  return value;
}
