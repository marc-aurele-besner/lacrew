/**
 * The org directory: which orgs a multi-org orchestrator serves, and what
 * each one is. Postgres (via @lacrew/db) when DATABASE_URL is set, else memory,
 * the same provider pattern as the other stores.
 *
 * An org is in the directory because it was registered by name. Addressing an
 * org that is not there never creates it.
 */

import {
  deleteOrg,
  getDatabaseUrl,
  getOrg,
  listOrgs,
  setOrgEpoch,
  upsertOrg,
  type DbHandle,
  type OrgRow,
} from "@lacrew/db";
import { keccak256, toHex } from "viem";
import { sharedDb } from "./dbPool.js";

/** What an org id may be. It is a URL path segment and a storage key, so nothing else is let through. */
export const ORG_ID_PATTERN = /^[a-z0-9_-]{1,64}$/;

export function isOrgId(value: unknown): value is string {
  return typeof value === "string" && ORG_ID_PATTERN.test(value);
}

/**
 * How an org is run: `sandbox` is simulated in process with no chain;
 * `testnet` and `mainnet` are bound to deployed contracts.
 */
export const ORG_MODES = ["sandbox", "testnet", "mainnet"] as const;
export type OrgMode = (typeof ORG_MODES)[number];

export function isOrgMode(value: unknown): value is OrgMode {
  return typeof value === "string" && (ORG_MODES as readonly string[]).includes(value);
}

export interface OrgRecord {
  orgId: string;
  mode: OrgMode;
  /** EIP-155 chain id of a chain org; null for a sandbox. */
  chainId: number | null;
  /** The org's deployed contract addresses, by name; null until it has any. */
  addresses: Record<string, string> | null;
  /** Accounts holding the org's seats, by role (`root`, ...). Addresses only. */
  seats: Record<string, string> | null;
  /** The org's own epoch cron; null when it runs on the operator's default. */
  epochCron: string | null;
  /** ISO time the org's next scheduled epoch is due, on the org's own clock. */
  epochNextAt: string | null;
  /** The same moment on the wall clock: `epochNextAt` less the time the org has skipped. */
  epochDueAt: string | null;
  createdAt: string;
}

/** A write to an org's epoch cadence. `cron` is left as it is when not given. */
export interface OrgEpochChange {
  cron?: string | null;
  nextAt: string | null;
  dueAt: string | null;
}

export interface OrgDirectory {
  readonly name: string;
  get(orgId: string): Promise<OrgRecord | null>;
  /** Every registered org, oldest first. */
  list(): Promise<OrgRecord[]>;
  /**
   * Register an org, or change the mode of a registered one. Its chain id,
   * addresses and seats are left as they are.
   */
  put(orgId: string, input: { mode: OrgMode }): Promise<{ org: OrgRecord; created: boolean }>;
  /**
   * Write an org's epoch cadence. With `ifNextAt`, only while the stored
   * `epochNextAt` is still that value, which is how one due epoch is claimed
   * by one caller. Null when the org is not registered or the stored time had
   * already moved.
   */
  setEpoch(
    orgId: string,
    change: OrgEpochChange,
    ifNextAt?: string | null,
  ): Promise<OrgRecord | null>;
  /**
   * Remove an org and everything stored under it. False when it was not
   * registered.
   */
  remove(orgId: string): Promise<boolean>;
  close(): Promise<void>;
}

/**
 * The human root of a sandbox org whose directory row names none.
 *
 * Derived from the org id, so every sandbox org has a root of its own and the
 * same org always gets the same one. Nobody holds a key for it and none is
 * needed: a sandbox verifies no signature.
 */
export function sandboxRootFor(orgId: string): `0x${string}` {
  return `0x${keccak256(toHex(`lacrew:sandbox-root:${orgId}`)).slice(-40)}`;
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/** The root a sandbox org is built with: the directory's, or the derived one. */
export function sandboxRootOf(org: Pick<OrgRecord, "orgId" | "seats">): `0x${string}` {
  const named = org.seats?.root;
  return named && ADDRESS.test(named) ? (named as `0x${string}`) : sandboxRootFor(org.orgId);
}

/** Whether a chain org has what a runtime needs to be bound to its contracts. */
export function isProvisioned(org: Pick<OrgRecord, "mode" | "chainId" | "addresses">): boolean {
  if (org.mode === "sandbox") return true;
  return org.chainId != null && org.addresses != null && Object.keys(org.addresses).length > 0;
}

/** Holds the directory for the life of the process (or of a test). */
export function createMemoryOrgDirectory(): OrgDirectory {
  const rows = new Map<string, OrgRecord>();
  return {
    name: "memory",
    get: async (orgId) => {
      const row = rows.get(orgId);
      return row ? structuredClone(row) : null;
    },
    list: async () => [...rows.values()].map((row) => structuredClone(row)),
    put: async (orgId, input) => {
      const existing = rows.get(orgId);
      const org: OrgRecord = existing
        ? { ...existing, mode: input.mode }
        : {
            orgId,
            mode: input.mode,
            chainId: null,
            addresses: null,
            seats: null,
            epochCron: null,
            epochNextAt: null,
            epochDueAt: null,
            createdAt: new Date().toISOString(),
          };
      rows.set(orgId, org);
      return { org: structuredClone(org), created: !existing };
    },
    setEpoch: async (orgId, change, ifNextAt) => {
      const existing = rows.get(orgId);
      if (!existing) return null;
      if (ifNextAt !== undefined && existing.epochNextAt !== ifNextAt) return null;
      const org: OrgRecord = {
        ...existing,
        ...(change.cron === undefined ? {} : { epochCron: change.cron }),
        epochNextAt: change.nextAt,
        epochDueAt: change.dueAt,
      };
      rows.set(orgId, org);
      return structuredClone(org);
    },
    remove: async (orgId) => rows.delete(orgId),
    close: async () => {},
  };
}

function toRecord(row: OrgRow): OrgRecord {
  return {
    orgId: row.orgId,
    // A row written by a newer build with a mode this one does not know is
    // served as what it cannot be run as, rather than as a sandbox it is not.
    mode: isOrgMode(row.mode) ? row.mode : "mainnet",
    chainId: row.chainId,
    addresses: row.addresses,
    seats: row.seats,
    epochCron: row.epochCron,
    epochNextAt: row.epochNextAt,
    epochDueAt: row.epochDueAt,
    createdAt: row.createdAt,
  };
}

export function createPgOrgDirectory(options: { db: DbHandle }): OrgDirectory {
  const db = () => options.db;
  return {
    name: "postgres",
    get: async (orgId) => {
      const row = await getOrg(db(), orgId);
      return row ? toRecord(row) : null;
    },
    list: async () => (await listOrgs(db())).map(toRecord),
    put: async (orgId, input) => {
      const { org, created } = await upsertOrg(db(), { orgId, mode: input.mode });
      return { org: toRecord(org), created };
    },
    setEpoch: async (orgId, change, ifNextAt) => {
      const row = await setOrgEpoch(db(), orgId, change, ifNextAt);
      return row ? toRecord(row) : null;
    },
    remove: (orgId) => deleteOrg(db(), orgId),
    // The pool belongs to whoever injected it, and is closed there.
    close: async () => {},
  };
}

/** Postgres when DATABASE_URL is set, memory otherwise. */
export function createOrgDirectoryFromEnv(): OrgDirectory {
  return getDatabaseUrl() ? createPgOrgDirectory({ db: sharedDb() }) : createMemoryOrgDirectory();
}
