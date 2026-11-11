/** Query helpers for the org directory (keeps Drizzle inside @lacrew/db). */

import { and, eq, getTableColumns, getTableName, isNull, sql } from "drizzle-orm";
import { PgTable, type PgColumn } from "drizzle-orm/pg-core";
import { assertValidOrgId, type DbHandle } from "./client.js";
import * as schema from "./schema/index.js";
import { orgs } from "./schema/orgs.js";

export interface OrgRow {
  orgId: string;
  /** `sandbox`, `testnet` or `mainnet`. */
  mode: string;
  chainId: number | null;
  addresses: Record<string, string> | null;
  seats: Record<string, string> | null;
  /** The org's own epoch cron; null when it runs on the operator's default. */
  epochCron: string | null;
  /** ISO time the next scheduled epoch is due, on the org's own clock. */
  epochNextAt: string | null;
  /** ISO time the next scheduled epoch is due, on the wall clock. */
  epochDueAt: string | null;
  /** ISO timestamp the org was first registered at. */
  createdAt: string;
}

function toOrg(row: typeof orgs.$inferSelect): OrgRow {
  return {
    orgId: row.orgId,
    mode: row.mode,
    chainId: row.chainId,
    addresses: row.addresses,
    seats: row.seats,
    epochCron: row.epochCron,
    epochNextAt: row.epochNextAt?.toISOString() ?? null,
    epochDueAt: row.epochDueAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

export async function getOrg(handle: DbHandle, orgId: string): Promise<OrgRow | null> {
  const rows = await handle.db.select().from(orgs).where(eq(orgs.orgId, orgId)).limit(1);
  return rows[0] ? toOrg(rows[0]) : null;
}

/** Every registered org, oldest first. */
export async function listOrgs(handle: DbHandle): Promise<OrgRow[]> {
  const rows = await handle.db.select().from(orgs).orderBy(orgs.createdAt, orgs.orgId);
  return rows.map(toOrg);
}

/**
 * Register an org, or change what a registered one is.
 *
 * Only the fields given are written on an existing row, so re-registering an
 * org with its mode alone leaves its addresses and seats as they were. Returns
 * the row as stored and whether this call created it.
 */
export async function upsertOrg(
  handle: DbHandle,
  input: {
    orgId: string;
    mode: string;
    chainId?: number | null;
    addresses?: Record<string, string> | null;
    seats?: Record<string, string> | null;
  },
): Promise<{ org: OrgRow; created: boolean }> {
  const orgId = assertValidOrgId(input.orgId);
  const changes = {
    mode: input.mode,
    ...(input.chainId === undefined ? {} : { chainId: input.chainId }),
    ...(input.addresses === undefined ? {} : { addresses: input.addresses }),
    ...(input.seats === undefined ? {} : { seats: input.seats }),
  };
  const rows = await handle.db
    .insert(orgs)
    .values({ orgId, ...changes })
    .onConflictDoUpdate({ target: orgs.orgId, set: changes })
    // `xmax` is zero only on a row this statement inserted.
    .returning({ ...getTableColumns(orgs), created: sql<boolean>`(xmax = 0)` });
  const { created, ...row } = rows[0]!;
  return { org: toOrg(row), created };
}

/**
 * Write an org's epoch cadence: its cron (left as it is when not given) and
 * when its next epoch is due, on its own clock and on the wall clock.
 *
 * With `ifNextAt`, the write lands only while the stored `epochNextAt` is
 * still that value. That is how one due epoch is claimed: of any number of
 * callers that read the same due time, one moves it on and runs the epoch.
 * Returns the row as stored, or null when the org is not registered or the
 * stored time had already moved.
 */
export async function setOrgEpoch(
  handle: DbHandle,
  orgId: string,
  change: { cron?: string | null; nextAt: string | null; dueAt: string | null },
  ifNextAt?: string | null,
): Promise<OrgRow | null> {
  const held =
    ifNextAt === undefined
      ? undefined
      : ifNextAt === null
        ? isNull(orgs.epochNextAt)
        : eq(orgs.epochNextAt, new Date(ifNextAt));
  const rows = await handle.db
    .update(orgs)
    .set({
      ...(change.cron === undefined ? {} : { epochCron: change.cron }),
      epochNextAt: change.nextAt === null ? null : new Date(change.nextAt),
      epochDueAt: change.dueAt === null ? null : new Date(change.dueAt),
    })
    .where(and(eq(orgs.orgId, orgId), held))
    .returning();
  return rows[0] ? toOrg(rows[0]) : null;
}

/**
 * Remove an org from the directory and delete every row stored under it, in
 * one transaction. Returns whether the org was registered.
 *
 * The tables are walked from the schema rather than listed, so a table added
 * later is cleared here without anybody remembering to add it.
 */
export async function deleteOrg(handle: DbHandle, orgId: string): Promise<boolean> {
  return handle.db.transaction(async (tx) => {
    const removed = await tx
      .delete(orgs)
      .where(eq(orgs.orgId, orgId))
      .returning({ orgId: orgs.orgId });
    for (const table of Object.values(schema as Record<string, unknown>)) {
      if (!(table instanceof PgTable) || getTableName(table) === getTableName(orgs)) continue;
      const columns: PgColumn[] = Object.values(getTableColumns(table));
      const column = columns.find((c) => c.name === "org_id");
      if (!column) continue;
      await tx.delete(table).where(eq(column, orgId));
    }
    return removed.length > 0;
  });
}
